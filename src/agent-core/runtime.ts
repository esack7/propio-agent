import {
  type ChatMessage,
  type ChatTool,
  type ChatToolCall,
  type ChatStreamEvent,
  type ProviderReasoningSummarySource,
  ProviderContextLengthError,
} from "@propio-ai/providers";
import { measureMessages } from "../diagnostics.js";
import type {
  ArtifactToolResult,
  PromptPlan,
  TurnEntry,
} from "../context/coreTypes.js";
import type { ToolExecutionResult } from "../tools/types.js";
import type { AgentDiagnosticEvent } from "../diagnostics.js";
import type { PromptSubmission } from "./input.js";
import type { AgentRuntimeOptions } from "./types.js";
import type {
  AgentVisibilityEvent,
  AgentEventOptions,
  AgentToolOptions,
  AgentStreamOptions,
  TurnReasoningSummary,
  PromptPlanSnapshot,
} from "./events.js";
function stableArgsKey(
  args: Record<string, unknown> | null | undefined,
): string {
  if (!args || typeof args !== "object") return "";
  return Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join("|");
}

function normalizeAssistantText(content: string | undefined | null): string {
  return (content ?? "").trim().replace(/\s+/g, " ");
}

function buildAssistantToolIterationSignature(
  content: string | undefined | null,
  toolCalls: ReadonlyArray<ChatToolCall> | undefined,
): string {
  const textSignature = normalizeAssistantText(content);
  const toolSignature = (toolCalls ?? [])
    .map(
      (toolCall) =>
        `${toolCall.function.name}:${stableArgsKey(toolCall.function.arguments)}`,
    )
    .join(",");
  return `${textSignature}|${toolSignature}`;
}

export class AgentRuntime {
  private static readonly MAX_EMPTY_TOOL_ONLY_STREAK = 3;
  private static readonly MAX_VISIBILITY_PREVIEW_CHARS = 120;
  private static readonly MAX_CONTEXT_RETRY_LEVEL = 3;
  private turnStarted = false;
  private running = false;
  constructor(private readonly dependencies: AgentRuntimeOptions) {}
  private get provider() {
    return this.dependencies.provider;
  }
  private get model() {
    return this.dependencies.model;
  }
  private get contextManager() {
    return this.dependencies.context;
  }
  private get runtimeConfig() {
    return this.dependencies.policy;
  }
  private emitDiagnostic(event: AgentDiagnosticEvent): void {
    this.dependencies.onDiagnosticEvent?.(event);
  }
  private resolveContextWindowTokens(): number {
    return this.provider.getCapabilities().contextWindowTokens;
  }
  private getMergedToolSchemas(allowed?: ReadonlySet<string>): ChatTool[] {
    return this.dependencies.tools
      .getEnabledSchemas()
      .filter((tool) => !allowed || allowed.has(tool.function.name));
  }
  private describeToolInvocation(
    name: string,
    _args: Record<string, unknown>,
  ): string {
    return name;
  }
  private prepareMessagesForProvider(messages: ChatMessage[]): ChatMessage[] {
    return (
      this.dependencies.integrations?.prepareMessages?.(messages) ?? messages
    );
  }
  private async executeToolWithStatus(
    name: string,
    args: Record<string, unknown>,
    allowed?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (allowed && !allowed.has(name))
      return {
        status: "tool_disabled",
        content: `Tool not available in the current mode or skill scope: ${name}`,
      };
    try {
      return await this.dependencies.tools.executeWithStatus(name, args, {
        signal,
      });
    } catch (error) {
      this.throwIfAbortCancelled(signal);
      return {
        status: "error",
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }
  private buildPlan(
    extraUserInstruction?: string,
    retryLevel?: number,
    iteration?: number,
    allowedTools?: ReadonlySet<string>,
  ): PromptPlan {
    const contextWindowTokens = this.resolveContextWindowTokens();
    const plan =
      this.dependencies.integrations?.buildPlan?.(
        extraUserInstruction,
        retryLevel,
        iteration,
        allowedTools,
      ) ??
      this.contextManager.buildPromptPlan(
        this.dependencies.systemPrompt,
        extraUserInstruction,
        {
          contextWindowTokens,
          retryLevel,
          policy: this.dependencies.promptBudgetPolicy,
        },
      );
    return plan;
  }
  async streamChat(
    submission: PromptSubmission,
    onToken: (token: string) => void,
    options?: AgentStreamOptions,
  ): Promise<string> {
    if (this.running) throw new Error("An agent turn is already running");
    this.throwIfAbortCancelled(options?.abortSignal);
    this.running = true;
    this.turnStarted = false;
    try {
      this.emitVisibilityEvent(options, { type: "turn_started" });
      const result = await this.runTurn(
        submission,
        (token) => {
          this.emitVisibilityEvent(options, {
            type: "assistant_text",
            delta: token,
          });
          onToken(token);
        },
        options,
      );
      this.emitVisibilityEvent(options, { type: "turn_completed", result });
      return result;
    } catch (error) {
      try {
        this.emitTurnFailure(error, options);
      } finally {
        if (this.turnStarted)
          await this.dependencies.integrations?.failTurn?.(error);
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  private emitTurnFailure(error: unknown, options?: AgentStreamOptions): void {
    if (options?.abortSignal?.aborted) {
      if (
        this.dependencies.policy.discardInterruptedTurn?.(
          options.abortSignal,
        ) ??
        true
      )
        this.contextManager.abandonIncompleteTurn();
      this.emitVisibilityEvent(options, { type: "turn_cancelled" });
    } else {
      this.emitVisibilityEvent(options, { type: "turn_failed", error });
    }
  }

  private emitVisibilityEvent(
    options: AgentEventOptions | undefined,
    event: AgentVisibilityEvent,
  ): void {
    options?.onEvent?.(event);
  }

  private throwIfAbortCancelled(abortSignal?: AbortSignal): void {
    if (abortSignal?.aborted) {
      throw new Error("Request cancelled");
    }
  }

  /**
   * Reject when `abortSignal` fires even if `promise` is still pending. Does not
   * terminate underlying tool subprocesses or MCP requests.
   */
  private async awaitWithAbortSignal<T>(
    promise: Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    if (!abortSignal) {
      return await promise;
    }

    if (abortSignal.aborted) {
      void promise.catch(() => {});
      this.throwIfAbortCancelled(abortSignal);
    }

    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(new Error("Request cancelled"));
      };

      abortSignal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          abortSignal.removeEventListener("abort", onAbort);
          try {
            this.throwIfAbortCancelled(abortSignal);
          } catch (error) {
            reject(error);
            return;
          }
          resolve(value);
        },
        (error) => {
          abortSignal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private emitStatus(
    options: AgentEventOptions | undefined,
    status: string,
    phase?: string,
  ): void {
    this.emitVisibilityEvent(options, { type: "status", status, phase });
  }

  private toPreview(text: string): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= AgentRuntime.MAX_VISIBILITY_PREVIEW_CHARS) {
      return compact;
    }
    return `${compact.slice(0, AgentRuntime.MAX_VISIBILITY_PREVIEW_CHARS)}...`;
  }

  private normalizeStreamEvent(event: ChatStreamEvent): {
    delta?: string;
    thinkingDelta?: string;
    toolCalls?: ChatToolCall[];
    reasoningContent?: string;
    status?: { status: string; phase?: string };
    reasoningSummary?: {
      summary: string;
      source: ProviderReasoningSummarySource;
    };
    stopReason?: string;
  } {
    if (!("type" in event)) {
      return {
        delta: event.delta,
        toolCalls: event.toolCalls,
      };
    }

    if (event.type === "assistant_text") {
      return { delta: event.delta };
    }

    if (event.type === "thinking_delta") {
      return { thinkingDelta: event.delta };
    }

    if (event.type === "tool_calls") {
      return {
        toolCalls: event.toolCalls,
        reasoningContent: event.reasoningContent,
      };
    }

    if (event.type === "status") {
      return { status: { status: event.status, phase: event.phase } };
    }

    if (event.type === "reasoning_summary") {
      return {
        reasoningSummary: {
          summary: event.summary,
          source: event.source,
        },
      };
    }

    if (event.type === "terminal") {
      return { stopReason: event.stopReason };
    }

    return {};
  }

  private detectNoProgress(
    _currentToolCalls?: ChatToolCall[],
    lookback: number = 5,
  ): boolean {
    const state = this.contextManager.getConversationState();
    const turns = state.turns;

    if (turns.length === 0) return false;

    const lastTurn = turns[turns.length - 1];
    const recentEntries = lastTurn.entries.slice(-lookback);
    // commitAssistantResponse already ran before this check, so the current
    // iteration's assistant entry is already in history; read from there only.
    const signatures =
      this.gatherIterationSignaturesFromTurnEntries(recentEntries);

    if (signatures.length < AgentRuntime.MAX_EMPTY_TOOL_ONLY_STREAK)
      return false;

    return new Set(signatures).size === 1;
  }

  private gatherIterationSignaturesFromTurnEntries(
    entries: ReadonlyArray<TurnEntry>,
  ): string[] {
    const signatures: string[] = [];
    for (const entry of entries) {
      if (entry.kind !== "assistant") continue;
      const toolCalls = entry.message.toolCalls;
      if (!toolCalls || toolCalls.length === 0) continue;
      signatures.push(
        buildAssistantToolIterationSignature(entry.message.content, toolCalls),
      );
    }
    return signatures;
  }

  private synthesizeAgentReasoningSummary(
    iterationCount: number,
    toolExecutionEvents: Array<{ name: string; failed: boolean }>,
  ): string {
    if (toolExecutionEvents.length === 0) {
      return iterationCount > 1
        ? "Reviewed prior context and generated the final answer without running tools."
        : "Read your request and generated the answer directly without running tools.";
    }

    const namesInOrder: string[] = [];
    for (const event of toolExecutionEvents) {
      if (!namesInOrder.includes(event.name)) {
        namesInOrder.push(event.name);
      }
    }
    const failedCount = toolExecutionEvents.filter(
      (event) => event.failed,
    ).length;
    const completedCount = toolExecutionEvents.length - failedCount;
    const toolLabel =
      namesInOrder.length === 1
        ? namesInOrder[0]
        : `${namesInOrder.slice(0, -1).join(", ")} and ${namesInOrder[namesInOrder.length - 1]}`;

    if (failedCount === 0) {
      return `Used ${toolLabel}, processed the results, then generated the final answer.`;
    }

    return `Used ${toolLabel}; ${completedCount} completed and ${failedCount} failed. Continued with the available results to produce the final answer.`;
  }

  private emitPromptPlanDiagnostic(plan: PromptPlan, iteration: number): void {
    const contextWindowTokens = this.resolveContextWindowTokens();
    this.emitDiagnostic({
      type: "prompt_plan",
      provider: this.provider.name,
      model: this.model,
      iteration,
      contextWindowTokens,
      availableInputBudget: contextWindowTokens - plan.reservedOutputTokens,
      estimatedPromptTokens: plan.estimatedPromptTokens,
      reservedOutputTokens: plan.reservedOutputTokens,
      retryLevel: plan.retryLevel,
      includedTurnCount: plan.includedTurnIds.length,
      omittedTurnCount: plan.omittedTurnIds.length,
      includedArtifactCount: plan.includedArtifactIds.length,
      usedRollingSummary: plan.usedRollingSummary,
    });
  }

  private emitPromptPlanAndRequestStartedDiagnostics(
    plan: PromptPlan,
    messages: ChatMessage[],
    iteration: number,
    enabledTools: number,
    options: AgentEventOptions | undefined,
  ): void {
    this.emitPromptPlanDiagnostic(plan, iteration);
    if (options?.onEvent) {
      const contextWindowTokens = this.resolveContextWindowTokens();
      const snapshot: PromptPlanSnapshot = {
        provider: this.provider.name,
        model: this.model,
        iteration,
        contextWindowTokens,
        availableInputBudget: contextWindowTokens - plan.reservedOutputTokens,
        plan,
      };
      this.emitVisibilityEvent(options, {
        type: "prompt_plan_built",
        snapshot: structuredClone(snapshot),
      });
    }
    const contextSnapshot = this.contextManager.getSnapshot();
    const contextMetrics = measureMessages(contextSnapshot);
    this.emitDiagnostic({
      type: "context_snapshot",
      ...contextMetrics,
    });
    const promptMetrics = measureMessages(messages);
    this.emitDiagnostic({
      type: "request_started",
      provider: this.provider.name,
      model: this.model,
      iteration,
      contextMessages: messages.length,
      enabledTools,
      promptMessageCount: promptMetrics.messageCount,
      promptChars: promptMetrics.totalChars,
      estimatedPromptTokens: promptMetrics.estimatedTokens,
      reservedOutputTokens: plan.reservedOutputTokens,
    });
  }

  private recordStreamChunk(
    normalizedEvent: ReturnType<AgentRuntime["normalizeStreamEvent"]>,
    iteration: number,
    state: { fullResponse: string; chunkCount: number },
    onToken: (token: string) => void,
  ): void {
    const token = normalizedEvent.delta ?? "";
    const thinkingToken = normalizedEvent.thinkingDelta ?? "";
    if (token) {
      state.fullResponse += token;
    }
    state.chunkCount++;
    this.emitDiagnostic({
      type: "chunk_received",
      provider: this.provider.name,
      model: this.model,
      iteration,
      chunkIndex: state.chunkCount,
      chunkChars: token.length + thinkingToken.length,
      accumulatedChars: state.fullResponse.length,
    });
    if (token) {
      onToken(token);
    }
  }

  private normalizeAndEmitStreamEvent(
    event: ChatStreamEvent,
    options: AgentEventOptions | undefined,
    abortSignal: AbortSignal | undefined,
  ): ReturnType<AgentRuntime["normalizeStreamEvent"]> {
    if (abortSignal?.aborted) {
      throw new Error("Request cancelled");
    }

    const normalizedEvent = this.normalizeStreamEvent(event);

    if (normalizedEvent.status) {
      this.emitStatus(
        options,
        normalizedEvent.status.status,
        normalizedEvent.status.phase,
      );
    }

    if (normalizedEvent.thinkingDelta) {
      this.emitVisibilityEvent(options, {
        type: "thinking_delta",
        delta: normalizedEvent.thinkingDelta,
      });
    }

    if (normalizedEvent.reasoningSummary?.summary.trim()) {
      this.emitVisibilityEvent(options, {
        type: "thinking_delta",
        delta: normalizedEvent.reasoningSummary.summary,
      });
    }

    return normalizedEvent;
  }

  private async streamFinalResponseWithoutTools(
    messages: ChatMessage[],
    onToken: (token: string) => void,
    abortSignal: AbortSignal | undefined,
    iteration: number,
    options: AgentEventOptions | undefined,
  ): Promise<string> {
    const streamState = { fullResponse: "", chunkCount: 0 };
    this.emitStatus(options, "Streaming response", "response");
    for await (const event of this.withStreamIdleWatchdog(
      this.provider.streamChat({
        model: this.model,
        messages: this.prepareMessagesForProvider(messages),
        signal: abortSignal,
        iteration,
        requestReasoning: options?.requestReasoning,
      }),
      iteration,
      abortSignal,
    )) {
      const normalizedEvent = this.normalizeAndEmitStreamEvent(
        event,
        options,
        abortSignal,
      );
      this.recordStreamChunk(normalizedEvent, iteration, streamState, onToken);
    }

    this.throwIfAbortCancelled(abortSignal);
    this.contextManager.commitAssistantResponse(streamState.fullResponse);
    this.dependencies.integrations?.onAssistantResponse?.(
      streamState.fullResponse,
    );
    this.emitDiagnostic({
      type: "iteration_finished",
      provider: this.provider.name,
      model: this.model,
      iteration,
      responseChars: streamState.fullResponse.length,
      responseIsEmpty: streamState.fullResponse.trim().length === 0,
      toolCalls: 0,
    });

    if (streamState.fullResponse.trim().length === 0) {
      this.emitDiagnostic({
        type: "empty_response",
        provider: this.provider.name,
        model: this.model,
        iteration,
        contextMessages: this.contextManager.messageCount,
      });
    }

    return streamState.fullResponse;
  }

  private async requestFinalResponseWithoutTools(
    onToken: (token: string) => void,
    abortSignal: AbortSignal | undefined,
    iteration: number,
    options?: AgentEventOptions,
  ): Promise<string> {
    const noToolsInstruction =
      "Do not call tools. Provide the best final answer from the gathered context. If context is insufficient, explain what is missing briefly.";

    let retryLevel = 0;
    let shrinkCount = 0;

    const allowedTools = this.dependencies.policy.allowedTools?.();

    while (retryLevel <= AgentRuntime.MAX_CONTEXT_RETRY_LEVEL) {
      const plan = this.buildPlan(
        noToolsInstruction,
        retryLevel,
        iteration,
        allowedTools,
      );
      const messages = plan.messages as ChatMessage[];
      this.emitPromptPlanAndRequestStartedDiagnostics(
        plan,
        messages,
        iteration,
        0,
        options,
      );

      try {
        return await this.streamFinalResponseWithoutTools(
          messages,
          onToken,
          abortSignal,
          iteration,
          options,
        );
      } catch (error) {
        if (!(error instanceof ProviderContextLengthError)) throw error;
        const retryAction = await this.handleContextLengthError(
          plan,
          retryLevel,
          shrinkCount,
          iteration,
        );
        if (retryAction.action === "rethrow") throw error;
        retryLevel = retryAction.contextRetryLevel;
        shrinkCount = retryAction.synchronousShrinkCount;
        continue;
      }
    }

    throw new Error("Exhausted all context retry levels");
  }

  // Provider stream handling branches by event shape; keep the loop centralized
  // so response text, tool calls, reasoning, and stop reasons stay in order.
  // fallow-ignore-next-line complexity
  private async collectProviderStream(
    messages: ChatMessage[],
    allowedTools: ReadonlySet<string> | undefined,
    iteration: number,
    options: AgentToolOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<{
    fullResponse: string;
    toolCalls?: ChatToolCall[];
    reasoningContent?: string;
    providerReasoningSummary: TurnReasoningSummary | null;
    stopReason?: string;
  }> {
    const streamState = { fullResponse: "", chunkCount: 0 };
    let toolCalls: ChatToolCall[] | undefined;
    let reasoningContent: string | undefined;
    const providerReasoningSummaryChunks: string[] = [];
    let stopReason: string | undefined;

    this.emitStatus(options, "Streaming response", "response");

    for await (const event of this.withStreamIdleWatchdog(
      this.provider.streamChat({
        model: this.model,
        messages: this.prepareMessagesForProvider(messages),
        tools: this.getMergedToolSchemas(allowedTools),
        signal: options?.abortSignal,
        iteration,
        requestReasoning: options?.requestReasoning,
      }),
      iteration,
      options?.abortSignal,
    )) {
      const normalizedEvent = this.normalizeAndEmitStreamEvent(
        event,
        options,
        options?.abortSignal,
      );
      if (normalizedEvent.reasoningSummary?.summary.trim()) {
        providerReasoningSummaryChunks.push(
          normalizedEvent.reasoningSummary.summary,
        );
      }

      this.recordStreamChunk(normalizedEvent, iteration, streamState, onToken);

      if (normalizedEvent.toolCalls) {
        toolCalls = normalizedEvent.toolCalls;
        reasoningContent = normalizedEvent.reasoningContent;
      }

      if (normalizedEvent.stopReason) {
        stopReason = normalizedEvent.stopReason;
      }
    }

    this.throwIfAbortCancelled(options?.abortSignal);

    return {
      fullResponse: streamState.fullResponse,
      toolCalls,
      reasoningContent,
      providerReasoningSummary:
        providerReasoningSummaryChunks.length > 0
          ? {
              summary: providerReasoningSummaryChunks.join(""),
              source: "provider",
            }
          : null,
      stopReason,
    };
  }

  private async *withStreamIdleWatchdog(
    source: AsyncIterable<ChatStreamEvent>,
    iteration: number,
    abortSignal?: AbortSignal,
  ): AsyncIterable<ChatStreamEvent> {
    const timeoutMs = this.runtimeConfig.streamIdleTimeoutMs;
    const iter = source[Symbol.asyncIterator]();
    let completed = false;
    try {
      while (true) {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const pending = [this.awaitWithAbortSignal(iter.next(), abortSignal)];
        if (timeoutMs > 0) {
          pending.push(
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                this.emitDiagnostic({
                  type: "stream_idle_aborted",
                  provider: this.provider.name,
                  model: this.model,
                  iteration,
                  timeoutMs,
                });
                reject(new Error(`Stream idle timeout after ${timeoutMs}ms`));
              }, timeoutMs);
            }),
          );
        }

        try {
          const result = await Promise.race(pending);
          clearTimeout(timeoutHandle);
          if (result.done) {
            completed = true;
            return;
          }
          yield result.value;
        } catch (err) {
          clearTimeout(timeoutHandle);
          throw err;
        }
      }
    } finally {
      const closeResult = Promise.resolve().then(() => iter.return?.());
      if (!completed || abortSignal?.aborted) {
        void closeResult.catch(() => {});
      } else {
        await closeResult;
      }
    }
  }

  private async executeToolCalls(
    toolCallsToExecute: ChatToolCall[],
    allowedTools: ReadonlySet<string> | undefined,
    iteration: number,
    options: AgentToolOptions | undefined,
    onToken: (token: string) => void,
    toolExecutionEvents: Array<{ name: string; failed: boolean }>,
  ): Promise<void> {
    this.dependencies.integrations?.onToolBatch?.();
    const artifactToolResults: ArtifactToolResult[] = [];

    for (const toolCall of toolCallsToExecute) {
      const raw = await this.processToolCall(
        toolCall,
        allowedTools,
        iteration,
        options,
        onToken,
        toolExecutionEvents,
      );
      artifactToolResults.push(
        this.dependencies.integrations?.processToolResult?.(raw) ?? raw,
      );
    }

    this.contextManager.recordToolResults(artifactToolResults);
  }

  private async runToolWithAbort(
    toolName: string,
    args: Record<string, unknown> | undefined,
    allowedTools: ReadonlySet<string> | undefined,
    abortSignal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    this.throwIfAbortCancelled(abortSignal);
    // Local tools receive cooperative cancellation; integrations may still run.
    const execResult = await this.awaitWithAbortSignal(
      this.executeToolWithStatus(
        toolName,
        args ?? {},
        allowedTools,
        abortSignal,
      ),
      abortSignal,
    );
    this.throwIfAbortCancelled(abortSignal);
    return execResult;
  }

  private async processToolCall(
    toolCall: ChatToolCall,
    allowedTools: ReadonlySet<string> | undefined,
    iteration: number,
    options: AgentToolOptions | undefined,
    onToken: (token: string) => void,
    toolExecutionEvents: Array<{ name: string; failed: boolean }>,
  ): Promise<ArtifactToolResult> {
    this.throwIfAbortCancelled(options?.abortSignal);

    const args = toolCall.function.arguments;
    const safeArgs = args ?? {};
    const toolName = toolCall.function.name;
    const serializedArgs = JSON.stringify(safeArgs);
    const toolCallId = toolCall.id!;
    const activityLabel = this.describeToolInvocation(toolName, safeArgs);

    this.emitToolStartedDiagnostics(
      toolName,
      toolCallId,
      activityLabel,
      safeArgs,
      serializedArgs,
      iteration,
      options,
    );

    const execResult = await this.runToolWithAbort(
      toolName,
      args,
      allowedTools,
      options?.abortSignal,
    );
    const result = execResult.content;
    const failed = this.emitToolFinishedEvents(
      toolName,
      toolCallId,
      activityLabel,
      safeArgs,
      result,
      execResult,
      iteration,
      options,
    );

    if (!failed) {
      this.dependencies.integrations?.onToolSuccess?.(toolName, safeArgs);
    }
    toolExecutionEvents.push({ name: toolName, failed });

    return {
      toolCallId,
      toolName,
      rawContent: result,
      status: failed ? "error" : "success",
      externalStorage: execResult.externalStorage,
    };
  }

  private emitToolStartedDiagnostics(
    toolName: string,
    toolCallId: string,
    activityLabel: string,
    args: Record<string, unknown>,
    serializedArgs: string,
    iteration: number,
    options: AgentToolOptions | undefined,
  ): void {
    this.emitStatus(options, "Running tool", "tool");
    this.emitVisibilityEvent(options, {
      type: "tool_started",
      toolName,
      toolCallId,
      activityLabel,
      useLabel: null,
      args,
      argumentChars: serializedArgs.length,
      argumentPreview: this.toPreview(serializedArgs),
    });
    this.emitDiagnostic({
      type: "tool_execution_started",
      provider: this.provider.name,
      model: this.model,
      iteration,
      toolName,
      toolCallId,
      argsChars: serializedArgs.length,
    });
  }

  private emitToolFinishedEvents(
    toolName: string,
    toolCallId: string,
    activityLabel: string,
    args: Record<string, unknown>,
    result: string,
    execResult: ToolExecutionResult,
    iteration: number,
    options: AgentToolOptions | undefined,
  ): boolean {
    const failed = execResult.status !== "success";
    this.emitDiagnostic({
      type: "tool_execution_finished",
      provider: this.provider.name,
      model: this.model,
      iteration,
      toolName,
      toolCallId,
      resultChars: result.length,
      truncatedForContext: false,
      status: execResult.status,
    });
    const resultPreview = this.toPreview(result);
    this.emitVisibilityEvent(options, {
      type: failed ? "tool_failed" : "tool_finished",
      toolName,
      toolCallId,
      activityLabel,
      resultPreview,
      result,
      args,
      status: execResult.status,
    });
    return failed;
  }

  private async finalizeWithNoToolsResponse(
    onToken: (token: string) => void,
    options: AgentStreamOptions | undefined,
    iterationCount: number,
    emptyToolOnlyStreak: number,
    emptyResponseErrorMessage: string,
  ): Promise<{
    finalResponse: string;
    continueLoop: boolean;
    emptyToolOnlyStreak: number;
    hasFinalAssistantResponse: boolean;
  }> {
    this.contextManager.removeLastUnresolvedAssistantMessage();

    const finalResponse = await this.requestFinalResponseWithoutTools(
      onToken,
      options?.abortSignal,
      iterationCount + 1,
      options,
    );
    if (finalResponse.trim().length === 0) {
      throw new Error(emptyResponseErrorMessage);
    }

    return {
      finalResponse,
      continueLoop: false,
      emptyToolOnlyStreak,
      hasFinalAssistantResponse: true,
    };
  }

  private emitToolCallsReceivedDiagnostic(
    options: AgentStreamOptions | undefined,
    iterationCount: number,
    toolCalls: ChatToolCall[],
  ): void {
    if (toolCalls.length === 0) return;

    this.emitStatus(options, "Tool call received", "tool");
    this.emitDiagnostic({
      type: "tool_calls_received",
      provider: this.provider.name,
      model: this.model,
      iteration: iterationCount,
      count: toolCalls.length,
      tools: toolCalls.map((toolCall) => toolCall.function.name),
    });
  }

  private async handleChatTurnResponse(
    fullResponse: string,
    toolCalls: ChatToolCall[] | undefined,
    reasoningContent: string | undefined,
    iterationCount: number,
    options: AgentStreamOptions | undefined,
    onToken: (token: string) => void,
    allowedTools: ReadonlySet<string> | undefined,
    emptyToolOnlyStreak: number,
    toolExecutionEvents: Array<{ name: string; failed: boolean }>,
  ): Promise<{
    finalResponse: string;
    continueLoop: boolean;
    emptyToolOnlyStreak: number;
    hasFinalAssistantResponse: boolean;
  }> {
    const normalizedToolCalls = this.normalizeToolCallIds(
      toolCalls,
      iterationCount,
    );
    const toolCallsToExecute = normalizedToolCalls ?? [];
    const hasToolCalls = toolCallsToExecute.length > 0;
    this.emitToolCallsReceivedDiagnostic(
      options,
      iterationCount,
      toolCallsToExecute,
    );

    this.throwIfAbortCancelled(options?.abortSignal);
    this.contextManager.commitAssistantResponse(
      fullResponse,
      normalizedToolCalls,
      hasToolCalls ? { reasoningContent } : undefined,
    );
    this.dependencies.integrations?.onAssistantResponse?.(fullResponse);
    this.emitTurnFinishedDiagnostics(
      fullResponse,
      iterationCount,
      normalizedToolCalls,
    );

    const isEmptyResponse = fullResponse.trim().length === 0;
    const nextEmptyToolOnlyStreak =
      hasToolCalls && isEmptyResponse ? emptyToolOnlyStreak + 1 : 0;

    if (hasToolCalls) {
      const loopResult = await this.checkLoopAndFinalize(
        toolCallsToExecute,
        nextEmptyToolOnlyStreak,
        onToken,
        options,
        iterationCount,
        toolExecutionEvents,
      );
      if (loopResult !== null) return loopResult;

      onToken("\n");
      await this.executeToolCalls(
        toolCallsToExecute,
        allowedTools,
        iterationCount,
        options,
        onToken,
        toolExecutionEvents,
      );

      this.emitStatus(options, "Processing tool results", "tool");
      onToken("\n");
      return {
        finalResponse: fullResponse,
        continueLoop: true,
        emptyToolOnlyStreak: nextEmptyToolOnlyStreak,
        hasFinalAssistantResponse: false,
      };
    }

    this.emitStatus(options, "Generating final answer", "answer");
    return {
      finalResponse: fullResponse,
      continueLoop: false,
      emptyToolOnlyStreak: nextEmptyToolOnlyStreak,
      hasFinalAssistantResponse: true,
    };
  }

  private normalizeToolCallIds(
    toolCalls: ChatToolCall[] | undefined,
    iterationCount: number,
  ): ChatToolCall[] | undefined {
    return toolCalls?.map((toolCall, index) => ({
      ...toolCall,
      id: toolCall.id || `toolcall_${iterationCount}_${index}`,
    }));
  }

  private emitTurnFinishedDiagnostics(
    fullResponse: string,
    iterationCount: number,
    normalizedToolCalls: ChatToolCall[] | undefined,
  ): void {
    this.emitDiagnostic({
      type: "iteration_finished",
      provider: this.provider.name,
      model: this.model,
      iteration: iterationCount,
      responseChars: fullResponse.length,
      responseIsEmpty: fullResponse.trim().length === 0,
      toolCalls: normalizedToolCalls?.length ?? 0,
    });

    if (
      fullResponse.trim().length === 0 &&
      (!normalizedToolCalls || normalizedToolCalls.length === 0)
    ) {
      this.emitDiagnostic({
        type: "empty_response",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        contextMessages: this.contextManager.messageCount,
      });
    }
  }

  private async checkLoopAndFinalize(
    toolCallsToExecute: ChatToolCall[],
    nextEmptyToolOnlyStreak: number,
    onToken: (token: string) => void,
    options: AgentStreamOptions | undefined,
    iterationCount: number,
    toolExecutionEvents: Array<{ name: string; failed: boolean }>,
  ): Promise<{
    finalResponse: string;
    continueLoop: boolean;
    emptyToolOnlyStreak: number;
    hasFinalAssistantResponse: boolean;
  } | null> {
    void toolExecutionEvents;
    if (this.runtimeConfig.useNoProgressDetector) {
      if (!this.detectNoProgress(toolCallsToExecute)) return null;
      this.emitDiagnostic({
        type: "no_progress_detected",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        lookbackIterations: 5,
      });
      return this.finalizeWithNoToolsResponse(
        onToken,
        options,
        iterationCount,
        nextEmptyToolOnlyStreak,
        "Stopped after no-progress detection with no final assistant response.",
      );
    }

    if (nextEmptyToolOnlyStreak < AgentRuntime.MAX_EMPTY_TOOL_ONLY_STREAK)
      return null;
    this.emitDiagnostic({
      type: "tool_loop_detected",
      provider: this.provider.name,
      model: this.model,
      iteration: iterationCount,
      emptyToolOnlyStreak: nextEmptyToolOnlyStreak,
      threshold: AgentRuntime.MAX_EMPTY_TOOL_ONLY_STREAK,
      action: "fallback_no_tools",
    });
    return this.finalizeWithNoToolsResponse(
      onToken,
      options,
      iterationCount,
      nextEmptyToolOnlyStreak,
      "Stopped after repeated empty tool-calling turns with no final assistant response.",
    );
  }

  private async handleMaxTokensRecovery(
    initialResult: {
      fullResponse: string;
      toolCalls?: ChatToolCall[];
      reasoningContent?: string;
      stopReason?: string;
    },
    messages: ChatMessage[],
    allowedTools: ReadonlySet<string> | undefined,
    iterationCount: number,
    options: AgentStreamOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<{
    fullResponse: string;
    toolCalls?: ChatToolCall[];
    reasoningContent?: string;
  }> {
    let { fullResponse, toolCalls, reasoningContent } = initialResult;

    if (
      initialResult.stopReason !== "max_tokens" ||
      this.runtimeConfig.outputTokenRecoveryLimit <= 0
    ) {
      return { fullResponse, toolCalls, reasoningContent };
    }

    let recoveryAttempts = 0;
    let currentStopReason = initialResult.stopReason;

    while (
      recoveryAttempts < this.runtimeConfig.outputTokenRecoveryLimit &&
      currentStopReason === "max_tokens"
    ) {
      recoveryAttempts++;
      this.emitDiagnostic({
        type: "output_token_recovery_attempt",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        attemptNumber: recoveryAttempts,
      });

      const continuationMessages = [...messages];
      if (fullResponse.trim().length > 0) {
        continuationMessages.push({ role: "assistant", content: fullResponse });
      }
      continuationMessages.push({
        role: "user",
        content:
          "Continue with more detail if needed. If the response is complete, just reply with a period.",
      });

      const continuationResult = await this.collectProviderStream(
        continuationMessages,
        allowedTools,
        iterationCount,
        options,
        onToken,
      );

      fullResponse += continuationResult.fullResponse;
      if (continuationResult.toolCalls) {
        toolCalls = continuationResult.toolCalls;
        reasoningContent = continuationResult.reasoningContent;
      }
      currentStopReason = continuationResult.stopReason ?? currentStopReason;
    }

    if (currentStopReason === "max_tokens") {
      this.emitDiagnostic({
        type: "output_token_recovery_exhausted",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        maxAttempts: this.runtimeConfig.outputTokenRecoveryLimit,
      });
    }

    return { fullResponse, toolCalls, reasoningContent };
  }

  private async handleContextLengthError(
    plan: PromptPlan,
    contextRetryLevel: number,
    synchronousShrinkCount: number,
    iterationCount: number,
  ): Promise<
    | { action: "rethrow" }
    | {
        action: "retry";
        contextRetryLevel: number;
        synchronousShrinkCount: number;
      }
  > {
    if (contextRetryLevel >= AgentRuntime.MAX_CONTEXT_RETRY_LEVEL) {
      this.emitDiagnostic({
        type: "context_pressure_circuit_breaker",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        retryLevel: contextRetryLevel,
      });
      return { action: "rethrow" };
    }

    synchronousShrinkCount++;
    if (synchronousShrinkCount > AgentRuntime.MAX_CONTEXT_RETRY_LEVEL + 1) {
      this.emitDiagnostic({
        type: "context_pressure_circuit_breaker",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        retryLevel: contextRetryLevel,
      });
      return { action: "rethrow" };
    }

    const shrunk = await (this.dependencies.integrations?.shrinkContext?.(
      plan,
    ) ?? Promise.resolve(false));
    if (shrunk) {
      this.emitDiagnostic({
        type: "provider_error",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        errorName: "ProviderContextLengthError",
        message: `Context length exceeded, retrying after synchronous summary refresh at level ${contextRetryLevel}`,
      });
      return { action: "retry", contextRetryLevel, synchronousShrinkCount };
    }

    contextRetryLevel++;
    this.emitDiagnostic({
      type: "provider_error",
      provider: this.provider.name,
      model: this.model,
      iteration: iterationCount,
      errorName: "ProviderContextLengthError",
      message: `Context length exceeded, retrying at level ${contextRetryLevel}`,
    });
    return { action: "retry", contextRetryLevel, synchronousShrinkCount };
  }

  private validateTurnCompletion(
    continueLoop: boolean,
    iterationCount: number,
    maxIterations: number,
    toolCalls: ChatToolCall[] | undefined,
    hasFinalAssistantResponse: boolean,
    finalResponse: string,
    toolExecutionEvents: Array<{ name: string; failed: boolean }>,
  ): void {
    if (!continueLoop || iterationCount < maxIterations) return;

    const failedTools = Array.from(
      new Set(
        toolExecutionEvents
          .filter((event) => event.failed)
          .map((event) => event.name),
      ),
    );
    const failedToolCount = toolExecutionEvents.filter(
      (event) => event.failed,
    ).length;
    this.emitDiagnostic({
      type: "max_iterations_reached",
      provider: this.provider.name,
      model: this.model,
      maxIterations,
      iterationsCompleted: iterationCount,
      pendingToolCalls: toolCalls?.length ?? 0,
      failedToolCount,
      failedTools,
    });
    if (!hasFinalAssistantResponse || finalResponse.trim().length === 0) {
      const failedToolsSuffix =
        failedTools.length > 0
          ? ` Failed tools: ${failedTools.join(", ")}.`
          : "";
      throw new Error(
        `Stopped after reaching max iterations before a final assistant response. The last output may be incomplete.${failedToolsSuffix}`,
      );
    }
  }

  private selectTurnReasoningSummary(
    agentSummary: string,
    providerReasoningSummary: TurnReasoningSummary | null,
  ): TurnReasoningSummary {
    if (providerReasoningSummary?.summary.trim()) {
      return providerReasoningSummary;
    }

    if (agentSummary.trim().length > 0) {
      return { summary: agentSummary, source: "agent" };
    }

    return {
      summary: "Completed the request and generated the final response.",
      source: "agent",
    };
  }

  private appendProviderReasoningSummary(
    accumulatedSummary: TurnReasoningSummary | null,
    iterationSummary: TurnReasoningSummary | null,
  ): TurnReasoningSummary | null {
    if (!iterationSummary?.summary.trim()) {
      return accumulatedSummary;
    }
    if (!accumulatedSummary) {
      return iterationSummary;
    }
    return {
      summary: `${accumulatedSummary.summary}\n\n${iterationSummary.summary}`,
      source: "provider",
    };
  }

  private async runOneIteration(
    messages: ChatMessage[],
    allowedTools: ReadonlySet<string> | undefined,
    iterationCount: number,
    options: AgentStreamOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<{
    fullResponse: string;
    toolCalls?: ChatToolCall[];
    reasoningContent?: string;
    providerReasoningSummary: TurnReasoningSummary | null;
  }> {
    const streamResult = await this.collectProviderStream(
      messages,
      allowedTools,
      iterationCount,
      options,
      onToken,
    );
    const recovered = await this.handleMaxTokensRecovery(
      streamResult,
      messages,
      allowedTools,
      iterationCount,
      options,
      onToken,
    );
    return {
      ...recovered,
      providerReasoningSummary: streamResult.providerReasoningSummary,
    };
  }

  // Orchestration loop: while + nested context-length retry handling is structural;
  // business logic is extracted to dedicated helpers.
  // fallow-ignore-next-line complexity
  private async runTurn(
    submission: PromptSubmission,
    onToken: (token: string) => void,
    options?: AgentStreamOptions,
  ): Promise<string> {
    if (options?.abortSignal?.aborted) {
      throw new Error("Request cancelled");
    }

    const userMessage = submission.text;
    this.contextManager.beginUserTurn(userMessage, submission.images);
    await this.dependencies.integrations?.prepareTurn?.(submission);
    this.emitStatus(options, "Preparing request", "request");

    let iterationCount = 0;
    let contextRetryLevel = 0;
    let synchronousShrinkCount = 0;
    const toolExecutionEvents: Array<{ name: string; failed: boolean }> = [];
    let providerReasoningSummary: TurnReasoningSummary | null = null;
    const integrations = this.dependencies.integrations;
    const extraUserInstruction = integrations?.instructions
      ? integrations.instructions(options?.extraUserInstruction)
      : options?.extraUserInstruction;
    let fullResponse = "";
    let toolCalls: ChatToolCall[] | undefined;
    let reasoningContent: string | undefined;

    try {
      this.turnStarted = true;
      await this.dependencies.integrations?.startTurn?.();

      let finalResponse = "";
      let continueLoop = true;
      let hasFinalAssistantResponse = false;
      const maxIterations =
        options?.maxIterations ?? this.runtimeConfig.maxIterations;
      let emptyToolOnlyStreak = 0;

      while (continueLoop && iterationCount < maxIterations) {
        this.throwIfAbortCancelled(options?.abortSignal);
        iterationCount++;
        const allowedTools = this.dependencies.policy.allowedTools?.();

        const plan = this.buildPlan(
          extraUserInstruction,
          contextRetryLevel,
          iterationCount,
          allowedTools,
        );
        const messages = plan.messages as ChatMessage[];
        this.emitPromptPlanAndRequestStartedDiagnostics(
          plan,
          messages,
          iterationCount,
          this.getMergedToolSchemas(allowedTools).length,
          options,
        );

        try {
          const iterationResult = await this.runOneIteration(
            messages,
            allowedTools,
            iterationCount,
            options,
            onToken,
          );
          providerReasoningSummary = this.appendProviderReasoningSummary(
            providerReasoningSummary,
            iterationResult.providerReasoningSummary,
          );
          fullResponse = iterationResult.fullResponse;
          toolCalls = iterationResult.toolCalls;
          reasoningContent = iterationResult.reasoningContent;
        } catch (streamError) {
          if (!(streamError instanceof ProviderContextLengthError)) {
            throw streamError;
          }
          const retryAction = await this.handleContextLengthError(
            plan,
            contextRetryLevel,
            synchronousShrinkCount,
            iterationCount,
          );
          if (retryAction.action === "rethrow") throw streamError;
          contextRetryLevel = retryAction.contextRetryLevel;
          synchronousShrinkCount = retryAction.synchronousShrinkCount;
          iterationCount--;
          continue;
        }

        contextRetryLevel = 0;
        const turnResult = await this.handleChatTurnResponse(
          fullResponse,
          toolCalls,
          reasoningContent,
          iterationCount,
          options,
          onToken,
          allowedTools,
          emptyToolOnlyStreak,
          toolExecutionEvents,
        );
        finalResponse = turnResult.finalResponse;
        continueLoop = turnResult.continueLoop;
        emptyToolOnlyStreak = turnResult.emptyToolOnlyStreak;
        hasFinalAssistantResponse = turnResult.hasFinalAssistantResponse;
      }

      this.validateTurnCompletion(
        continueLoop,
        iterationCount,
        maxIterations,
        toolCalls,
        hasFinalAssistantResponse,
        finalResponse,
        toolExecutionEvents,
      );

      const agentSummary = this.synthesizeAgentReasoningSummary(
        iterationCount,
        toolExecutionEvents,
      );
      const selectedReasoningSummary = this.selectTurnReasoningSummary(
        agentSummary,
        providerReasoningSummary,
      );

      this.emitVisibilityEvent(options, {
        type: "reasoning_summary",
        summary: selectedReasoningSummary.summary,
        source: selectedReasoningSummary.source,
      });

      await this.dependencies.integrations?.completeTurn?.();

      return finalResponse;
    } catch (error) {
      this.emitDiagnostic({
        type: "provider_error",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        errorName: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
