import { LLMProvider } from "./providers/interface.js";
import {
  ChatMessage,
  ChatTool,
  ChatToolCall,
  ChatStreamEvent,
  ProviderReasoningSummarySource,
  ProviderError,
  ProviderAuthenticationError,
  ProviderModelNotFoundError,
  ProviderContextLengthError,
} from "./providers/types.js";
import { ProvidersConfig, ProviderConfig } from "./providers/config.js";
import { createProvider } from "./providers/factory.js";
import {
  loadProvidersConfig,
  resolveProvider,
  resolveModelKey,
} from "./providers/configLoader.js";
import { ToolRegistry } from "./tools/registry.js";
import { createDefaultToolRegistry } from "./tools/factory.js";
import { ExecutableTool } from "./tools/interface.js";
import {
  AgentDiagnosticEvent,
  measureMessages,
  RESERVED_OUTPUT_TOKENS,
} from "./diagnostics.js";
import { composeSystemPrompt } from "./agentsMd.js";
import { ContextManager } from "./context/contextManager.js";
import {
  ArtifactToolResult,
  PromptBudgetPolicy,
  DEFAULT_BUDGET_POLICY,
  SummaryPolicy,
  DEFAULT_SUMMARY_POLICY,
  PromptPlan,
  ConversationState,
  PinnedMemoryRecord,
  PinFactInput,
  UpdateMemoryInput,
} from "./context/types.js";
import { ToolExecutionStatus } from "./tools/types.js";
import { SummaryManager } from "./context/summaryManager.js";
import {
  serializeSession,
  parseSession,
  restoreConversationState,
  SessionMetadata,
} from "./context/persistence.js";

export type AgentVisibilityEvent =
  | { type: "status"; status: string; phase?: string }
  | {
      type: "tool_started";
      toolName: string;
      toolCallId: string;
      argumentChars: number;
      argumentPreview: string;
    }
  | {
      type: "tool_finished";
      toolName: string;
      toolCallId: string;
      resultPreview: string;
    }
  | {
      type: "tool_failed";
      toolName: string;
      toolCallId: string;
      resultPreview: string;
    }
  | {
      type: "reasoning_summary";
      summary: string;
      source: ProviderReasoningSummarySource;
    }
  | {
      type: "prompt_plan_built";
      snapshot: PromptPlanSnapshot;
    };

export interface TurnReasoningSummary {
  summary: string;
  source: ProviderReasoningSummarySource;
}

/**
 * Snapshot of a prompt plan plus the provider/model metadata that was
 * active when the plan was built. Surfaced via Agent.getLastPromptPlan()
 * for the /context prompt introspection command.
 */
export interface PromptPlanSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly iteration: number;
  readonly contextWindowTokens: number;
  readonly availableInputBudget: number;
  readonly plan: PromptPlan;
}

export class Agent {
  private static readonly MAX_EMPTY_TOOL_ONLY_STREAK = 3;
  private static readonly MAX_VISIBILITY_PREVIEW_CHARS = 120;
  private static readonly MAX_CONTEXT_RETRY_LEVEL = 3;
  private provider: LLMProvider;
  private model: string;
  private resolvedProviderConfig: ProviderConfig;
  private contextManager: ContextManager;
  private systemPrompt: string;
  private toolRegistry: ToolRegistry;
  private providersConfig: ProvidersConfig;
  private diagnosticsEnabled: boolean;
  private diagnosticsListener?: (event: AgentDiagnosticEvent) => void;
  private lastTurnReasoningSummary: TurnReasoningSummary | null = null;
  private lastPromptPlanSnapshot: PromptPlanSnapshot | null = null;
  private summaryManager: SummaryManager;
  private summaryPolicy: SummaryPolicy;
  private summaryRefreshRunning = false;
  private summaryDirty = false;
  private summaryGeneration = 0;

  constructor(
    options: {
      providersConfig: ProvidersConfig | string;
      providerName?: string;
      modelKey?: string;
      systemPrompt?: string;
      agentsMdContent?: string;
      diagnosticsEnabled?: boolean;
      onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;
    } = {} as any,
  ) {
    if (!options.providersConfig) {
      throw new Error(
        "Provider configuration is required. Please provide a providersConfig option with provider settings.",
      );
    }

    const basePrompt =
      options.systemPrompt || "You are a helpful AI assistant.";

    this.systemPrompt = composeSystemPrompt(
      options.agentsMdContent ?? "",
      basePrompt,
    );

    let config: ProvidersConfig;
    if (typeof options.providersConfig === "string") {
      config = loadProvidersConfig(options.providersConfig);
    } else {
      config = options.providersConfig;
    }

    this.providersConfig = config;
    this.diagnosticsEnabled = options.diagnosticsEnabled ?? false;
    this.diagnosticsListener = options.onDiagnosticEvent;

    const resolvedProvider = resolveProvider(config, options.providerName);
    const resolvedModelKey = resolveModelKey(
      resolvedProvider,
      options.modelKey,
    );

    this.resolvedProviderConfig = resolvedProvider;
    this.provider = createProvider(resolvedProvider, resolvedModelKey);
    this.model = resolvedModelKey;

    this.contextManager = new ContextManager();
    this.toolRegistry = createDefaultToolRegistry();
    this.summaryManager = new SummaryManager();
    this.summaryPolicy = DEFAULT_SUMMARY_POLICY;
  }

  private emitDiagnostic(event: AgentDiagnosticEvent): void {
    if (!this.diagnosticsEnabled || !this.diagnosticsListener) {
      return;
    }
    this.diagnosticsListener(event);
  }

  private emitVisibilityEvent(
    options:
      | {
          onEvent?: (event: AgentVisibilityEvent) => void;
        }
      | undefined,
    event: AgentVisibilityEvent,
  ): void {
    options?.onEvent?.(event);
  }

  private emitStatus(
    options:
      | {
          onEvent?: (event: AgentVisibilityEvent) => void;
        }
      | undefined,
    status: string,
    phase?: string,
  ): void {
    this.emitVisibilityEvent(options, { type: "status", status, phase });
  }

  private toPreview(text: string): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= Agent.MAX_VISIBILITY_PREVIEW_CHARS) {
      return compact;
    }
    return `${compact.slice(0, Agent.MAX_VISIBILITY_PREVIEW_CHARS)}...`;
  }

  private normalizeStreamEvent(event: ChatStreamEvent): {
    delta?: string;
    toolCalls?: ChatToolCall[];
    status?: { status: string; phase?: string };
    reasoningSummary?: {
      summary: string;
      source: ProviderReasoningSummarySource;
    };
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

    if (event.type === "tool_calls") {
      return { toolCalls: event.toolCalls };
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

    return {};
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

  private switchProvider(providerName: string, modelKey?: string): void {
    const resolvedProvider = resolveProvider(
      this.providersConfig,
      providerName,
    );
    const resolvedModelKey = resolveModelKey(resolvedProvider, modelKey);
    const newProvider = createProvider(resolvedProvider, resolvedModelKey);

    this.resolvedProviderConfig = resolvedProvider;
    this.provider = newProvider;
    this.model = resolvedModelKey;
  }

  /**
   * Resolve the effective context window size. Per-model config override
   * takes precedence over the provider's built-in capability default.
   */
  private resolveContextWindowTokens(): number {
    const modelEntry = this.resolvedProviderConfig.models.find(
      (m) => m.key === this.model,
    );
    if (modelEntry?.contextWindowTokens) {
      return modelEntry.contextWindowTokens;
    }
    return this.provider.getCapabilities().contextWindowTokens;
  }

  /**
   * Schedule a best-effort background summary refresh. If one is already
   * running, mark dirty so it reruns after completion. Non-fatal: failures
   * are logged via diagnostics and the previous summary is preserved.
   */
  private scheduleSummaryRefresh(
    reason: "turn_cadence" | "context_pressure",
  ): void {
    if (this.summaryRefreshRunning) {
      this.summaryDirty = true;
      return;
    }

    this.runSummaryRefresh(reason).catch(() => {
      // Errors already emitted as diagnostics; nothing to propagate.
    });
  }

  private async runSummaryRefresh(
    reason: "turn_cadence" | "context_pressure" | "synchronous_shrink",
  ): Promise<void> {
    this.summaryRefreshRunning = true;
    this.summaryDirty = false;
    const generation = this.summaryGeneration;

    try {
      const eligibility = this.contextManager.getSummaryEligibility(
        this.summaryPolicy,
      );
      if (eligibility.eligibleTurns.length === 0) {
        return;
      }

      const startTime = Date.now();
      const result = await this.summaryManager.generateSummary(
        this.provider,
        this.model,
        eligibility.eligibleTurns,
        this.contextManager.getRollingSummary(),
        this.summaryPolicy,
        undefined,
        {
          onRequestMeasured: (metrics) => {
            this.emitDiagnostic({
              type: "summary_refresh_started",
              provider: this.provider.name,
              model: this.model,
              eligibleTurnCount: eligibility.eligibleTurns.length,
              newEligibleCount: eligibility.newEligibleCount,
              reason,
              promptMessageCount: metrics.promptMessageCount,
              promptChars: metrics.promptChars,
              estimatedPromptTokens: metrics.estimatedPromptTokens,
            });
          },
        },
      );

      if (this.summaryGeneration !== generation) {
        return;
      }

      this.contextManager.setRollingSummary(result.summary);

      this.emitDiagnostic({
        type: "summary_refresh_completed",
        provider: this.provider.name,
        model: this.model,
        coveredTurnCount: result.summary.coveredTurnIds.length,
        summaryTokens: result.summary.estimatedTokens,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      this.emitDiagnostic({
        type: "summary_refresh_failed",
        provider: this.provider.name,
        model: this.model,
        errorName: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.summaryRefreshRunning = false;

      if (this.summaryDirty && this.summaryGeneration === generation) {
        this.scheduleSummaryRefresh("turn_cadence");
      }
    }
  }

  /**
   * Attempt a synchronous summary refresh before escalating to the next
   * retry level. Returns true if the summary was refreshed (caller should
   * rebuild at the same level), false if nothing could be done (caller
   * should bump retryLevel).
   *
   * Only fires when the current plan omits unsummarized turns, meaning
   * a fresh summary would let the builder use the summary-aware path
   * instead of dropping them silently.
   */
  private async attemptSynchronousShrink(plan: PromptPlan): Promise<boolean> {
    const coveredIds = this.contextManager.getSummaryCoveredTurnIds();
    const uncoveredOmitted = plan.omittedTurnIds.filter(
      (id) => !coveredIds.has(id),
    );
    if (uncoveredOmitted.length === 0) {
      return false;
    }

    // Invalidate any in-flight background refresh so it cannot overwrite
    // the result we are about to produce. The background job checks
    // summaryGeneration before calling setRollingSummary and will discard
    // its stale result.
    if (this.summaryRefreshRunning) {
      this.summaryGeneration++;
      this.summaryDirty = false;
    }

    try {
      await this.runSummaryRefresh("synchronous_shrink");
    } catch {
      return false;
    }

    const newCoveredIds = this.contextManager.getSummaryCoveredTurnIds();
    return uncoveredOmitted.some((id) => newCoveredIds.has(id));
  }

  /**
   * Check eligibility and schedule a background refresh after a turn
   * completes. Called at the end of streamChat.
   */
  private checkAndScheduleSummary(): void {
    const contextWindow = this.resolveContextWindowTokens();
    const plan = this.buildPlan();
    const availableInputBudget = contextWindow - plan.reservedOutputTokens;

    const eligibility = this.contextManager.getSummaryEligibility(
      this.summaryPolicy,
      plan.estimatedPromptTokens,
      availableInputBudget,
    );

    if (eligibility.shouldRefresh && eligibility.reason) {
      this.scheduleSummaryRefresh(eligibility.reason);
    }
  }

  private buildPlan(
    extraUserInstruction?: string,
    retryLevel?: number,
    iteration?: number,
  ): PromptPlan {
    const contextWindowTokens = this.resolveContextWindowTokens();
    const plan = this.contextManager.buildPromptPlan(
      this.systemPrompt,
      extraUserInstruction,
      {
        contextWindowTokens,
        retryLevel,
      },
    );
    if (iteration != null) {
      this.lastPromptPlanSnapshot = {
        provider: this.provider.name,
        model: this.model,
        iteration,
        contextWindowTokens,
        availableInputBudget: contextWindowTokens - plan.reservedOutputTokens,
        plan,
      };
    }
    return plan;
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

  private async requestFinalResponseWithoutTools(
    onToken: (token: string) => void,
    abortSignal: AbortSignal | undefined,
    iteration: number,
    options?:
      | {
          onEvent?: (event: AgentVisibilityEvent) => void;
        }
      | undefined,
  ): Promise<string> {
    const noToolsInstruction =
      "Do not call tools. Provide the best final answer from the gathered context. If context is insufficient, explain what is missing briefly.";

    let retryLevel = 0;

    while (retryLevel <= Agent.MAX_CONTEXT_RETRY_LEVEL) {
      const plan = this.buildPlan(noToolsInstruction, retryLevel, iteration);
      const messages = plan.messages as ChatMessage[];
      this.emitPromptPlanDiagnostic(plan, iteration);
      this.emitVisibilityEvent(options, {
        type: "prompt_plan_built",
        snapshot: structuredClone(this.lastPromptPlanSnapshot!),
      });

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
        enabledTools: 0,
        promptMessageCount: promptMetrics.messageCount,
        promptChars: promptMetrics.totalChars,
        estimatedPromptTokens: promptMetrics.estimatedTokens,
        reservedOutputTokens: plan.reservedOutputTokens,
      });

      try {
        let fullResponse = "";
        let chunkCount = 0;
        this.emitStatus(options, "Streaming response", "response");
        for await (const event of this.provider.streamChat({
          model: this.model,
          messages,
          signal: abortSignal,
        })) {
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

          const token = normalizedEvent.delta ?? "";
          if (token) {
            fullResponse += token;
          }
          chunkCount++;
          this.emitDiagnostic({
            type: "chunk_received",
            provider: this.provider.name,
            model: this.model,
            iteration,
            chunkIndex: chunkCount,
            chunkChars: token.length,
            accumulatedChars: fullResponse.length,
          });
          if (token) onToken(token);
        }

        this.contextManager.commitAssistantResponse(fullResponse);
        this.emitDiagnostic({
          type: "iteration_finished",
          provider: this.provider.name,
          model: this.model,
          iteration,
          responseChars: fullResponse.length,
          responseIsEmpty: fullResponse.trim().length === 0,
          toolCalls: 0,
        });

        if (fullResponse.trim().length === 0) {
          this.emitDiagnostic({
            type: "empty_response",
            provider: this.provider.name,
            model: this.model,
            iteration,
            contextMessages: this.contextManager.messageCount,
          });
        }

        return fullResponse;
      } catch (error) {
        if (
          error instanceof ProviderContextLengthError &&
          retryLevel < Agent.MAX_CONTEXT_RETRY_LEVEL
        ) {
          const shrunk = await this.attemptSynchronousShrink(plan);
          if (shrunk) {
            this.emitDiagnostic({
              type: "provider_error",
              provider: this.provider.name,
              model: this.model,
              iteration,
              errorName: "ProviderContextLengthError",
              message: `Context length exceeded, retrying after synchronous summary refresh at level ${retryLevel}`,
            });
            continue;
          }
          retryLevel++;
          this.emitDiagnostic({
            type: "provider_error",
            provider: this.provider.name,
            model: this.model,
            iteration,
            errorName: "ProviderContextLengthError",
            message: `Context length exceeded, retrying at level ${retryLevel}`,
          });
          continue;
        }
        throw error;
      }
    }

    throw new Error("Exhausted all context retry levels");
  }

  async streamChat(
    userMessage: string,
    onToken: (token: string) => void,
    options?: {
      onToolStart?: (toolName: string) => void;
      onToolEnd?: (
        toolName: string,
        result: string,
        status: ToolExecutionStatus,
      ) => void;
      onEvent?: (event: AgentVisibilityEvent) => void;
      abortSignal?: AbortSignal;
    },
  ): Promise<string> {
    if (options?.abortSignal?.aborted) {
      throw new Error("Request cancelled");
    }

    this.contextManager.beginUserTurn(userMessage);
    this.lastTurnReasoningSummary = null;
    this.emitStatus(options, "Preparing request", "request");

    let iterationCount = 0;
    let contextRetryLevel = 0;
    const toolExecutionEvents: Array<{ name: string; failed: boolean }> = [];
    let providerReasoningSummary: TurnReasoningSummary | null = null;
    try {
      let finalResponse = "";
      let continueLoop = true;
      const maxIterations = 10;
      let emptyToolOnlyStreak = 0;

      while (continueLoop && iterationCount < maxIterations) {
        iterationCount++;

        const plan = this.buildPlan(
          undefined,
          contextRetryLevel,
          iterationCount,
        );
        const messages = plan.messages as ChatMessage[];
        this.emitPromptPlanDiagnostic(plan, iterationCount);
        this.emitVisibilityEvent(options, {
          type: "prompt_plan_built",
          snapshot: structuredClone(this.lastPromptPlanSnapshot!),
        });
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
          iteration: iterationCount,
          contextMessages: messages.length,
          enabledTools: this.toolRegistry.getEnabledSchemas().length,
          promptMessageCount: promptMetrics.messageCount,
          promptChars: promptMetrics.totalChars,
          estimatedPromptTokens: promptMetrics.estimatedTokens,
          reservedOutputTokens: plan.reservedOutputTokens,
        });

        let fullResponse = "";
        let toolCalls: ChatToolCall[] | undefined;
        let chunkCount = 0;
        this.emitStatus(options, "Streaming response", "response");

        try {
          for await (const event of this.provider.streamChat({
            model: this.model,
            messages: messages,
            tools: this.toolRegistry.getEnabledSchemas(),
            signal: options?.abortSignal,
          })) {
            if (options?.abortSignal?.aborted) {
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

            if (
              normalizedEvent.reasoningSummary &&
              !providerReasoningSummary &&
              normalizedEvent.reasoningSummary.summary.trim().length > 0
            ) {
              providerReasoningSummary = normalizedEvent.reasoningSummary;
            }

            const token = normalizedEvent.delta ?? "";
            if (token) {
              fullResponse += token;
            }
            chunkCount++;
            this.emitDiagnostic({
              type: "chunk_received",
              provider: this.provider.name,
              model: this.model,
              iteration: iterationCount,
              chunkIndex: chunkCount,
              chunkChars: token.length,
              accumulatedChars: fullResponse.length,
            });
            if (token) {
              onToken(token);
            }

            if (normalizedEvent.toolCalls) {
              toolCalls = normalizedEvent.toolCalls;
            }
          }
        } catch (streamError) {
          if (
            streamError instanceof ProviderContextLengthError &&
            contextRetryLevel < Agent.MAX_CONTEXT_RETRY_LEVEL
          ) {
            const shrunk = await this.attemptSynchronousShrink(plan);
            if (shrunk) {
              this.emitDiagnostic({
                type: "provider_error",
                provider: this.provider.name,
                model: this.model,
                iteration: iterationCount,
                errorName: "ProviderContextLengthError",
                message: `Context length exceeded, retrying after synchronous summary refresh at level ${contextRetryLevel}`,
              });
              iterationCount--;
              continue;
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
            iterationCount--;
            continue;
          }
          throw streamError;
        }

        contextRetryLevel = 0;

        const normalizedToolCalls = toolCalls?.map((toolCall, index) => ({
          ...toolCall,
          id: toolCall.id || `toolcall_${iterationCount}_${index}`,
        }));
        if (normalizedToolCalls && normalizedToolCalls.length > 0) {
          this.emitStatus(options, "Tool call received", "tool");
          this.emitDiagnostic({
            type: "tool_calls_received",
            provider: this.provider.name,
            model: this.model,
            iteration: iterationCount,
            count: normalizedToolCalls.length,
            tools: normalizedToolCalls.map(
              (toolCall) => toolCall.function.name,
            ),
          });
        }

        this.contextManager.commitAssistantResponse(
          fullResponse,
          normalizedToolCalls,
        );
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

        finalResponse = fullResponse;

        const toolCallsToExecute = normalizedToolCalls ?? [];
        const hasToolCalls = toolCallsToExecute.length > 0;
        const isEmptyResponse = fullResponse.trim().length === 0;
        emptyToolOnlyStreak =
          hasToolCalls && isEmptyResponse ? emptyToolOnlyStreak + 1 : 0;

        if (hasToolCalls) {
          if (emptyToolOnlyStreak >= Agent.MAX_EMPTY_TOOL_ONLY_STREAK) {
            this.emitDiagnostic({
              type: "tool_loop_detected",
              provider: this.provider.name,
              model: this.model,
              iteration: iterationCount,
              emptyToolOnlyStreak,
              threshold: Agent.MAX_EMPTY_TOOL_ONLY_STREAK,
              action: "fallback_no_tools",
            });

            this.contextManager.removeLastUnresolvedAssistantMessage();

            finalResponse = await this.requestFinalResponseWithoutTools(
              onToken,
              options?.abortSignal,
              iterationCount + 1,
              options,
            );
            continueLoop = false;
            if (finalResponse.trim().length === 0) {
              throw new Error(
                "Stopped after repeated empty tool-calling turns with no final assistant response.",
              );
            }
            continue;
          }

          onToken("\n");
          const artifactToolResults: ArtifactToolResult[] = [];

          for (const toolCall of toolCallsToExecute) {
            if (options?.abortSignal?.aborted) {
              throw new Error("Request cancelled");
            }

            const args = toolCall.function.arguments;
            const toolName = toolCall.function.name;
            const serializedArgs = JSON.stringify(args ?? {});
            const toolCallId = toolCall.id!;
            this.emitStatus(options, `Executing ${toolName}`, "tool");
            this.emitVisibilityEvent(options, {
              type: "tool_started",
              toolName,
              toolCallId,
              argumentChars: serializedArgs.length,
              argumentPreview: this.toPreview(serializedArgs),
            });
            this.emitDiagnostic({
              type: "tool_execution_started",
              provider: this.provider.name,
              model: this.model,
              iteration: iterationCount,
              toolName,
              toolCallId,
              argsChars: serializedArgs.length,
            });

            if (options?.onToolStart) {
              options.onToolStart(toolName);
            } else {
              onToken(`[Executing tool: ${toolName}]\n`);
            }

            const execResult = await this.toolRegistry.executeWithStatus(
              toolName,
              args,
            );
            const result = execResult.content;
            const failed = execResult.status !== "success";
            toolExecutionEvents.push({ name: toolName, failed });
            this.emitDiagnostic({
              type: "tool_execution_finished",
              provider: this.provider.name,
              model: this.model,
              iteration: iterationCount,
              toolName,
              toolCallId,
              resultChars: result.length,
              truncatedForContext: false,
              status: execResult.status,
            });

            artifactToolResults.push({
              toolCallId,
              toolName,
              rawContent: result,
              status: failed ? "error" : "success",
            });

            this.emitVisibilityEvent(options, {
              type: failed ? "tool_failed" : "tool_finished",
              toolName,
              toolCallId,
              resultPreview: this.toPreview(result),
            });

            if (options?.onToolEnd) {
              options.onToolEnd(toolName, result, execResult.status);
            } else {
              onToken(
                `[Tool result: ${result.substring(0, 100)}${result.length > 100 ? "..." : ""}]\n`,
              );
            }
          }

          this.contextManager.recordToolResults(artifactToolResults);

          this.emitStatus(options, "Processing tool results", "tool");
          onToken("\n");
        } else {
          this.emitStatus(options, "Generating final answer", "answer");
          continueLoop = false;
        }
      }

      if (continueLoop && iterationCount >= maxIterations) {
        this.emitDiagnostic({
          type: "max_iterations_reached",
          provider: this.provider.name,
          model: this.model,
          maxIterations,
        });
        if (finalResponse.trim().length === 0) {
          throw new Error(
            "Stopped after reaching max iterations without a final assistant response.",
          );
        }
      }

      const agentSummary = this.synthesizeAgentReasoningSummary(
        iterationCount,
        toolExecutionEvents,
      );
      const selectedReasoningSummary: TurnReasoningSummary =
        agentSummary.trim().length > 0
          ? { summary: agentSummary, source: "agent" }
          : (providerReasoningSummary ?? {
              summary:
                "Completed the request and generated the final response.",
              source: "agent",
            });

      this.lastTurnReasoningSummary = selectedReasoningSummary;
      this.emitVisibilityEvent(options, {
        type: "reasoning_summary",
        summary: selectedReasoningSummary.summary,
        source: selectedReasoningSummary.source,
      });

      this.checkAndScheduleSummary();

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
      throw this.handleProviderError(error);
    }
  }

  clearContext(): void {
    this.summaryGeneration++;
    this.summaryDirty = false;
    this.lastPromptPlanSnapshot = null;
    this.contextManager.clear();
  }

  getContext(): ChatMessage[] {
    return this.contextManager.getSnapshot();
  }

  getConversationState(): ConversationState {
    return this.contextManager.getConversationState();
  }

  getLastPromptPlan(): PromptPlanSnapshot | null {
    if (!this.lastPromptPlanSnapshot) return null;
    return structuredClone(this.lastPromptPlanSnapshot);
  }

  /**
   * Export the current session as a versioned JSON snapshot string.
   * The snapshot includes structured context state and runtime metadata
   * (provider, model, system prompt, policies) for analysis and future
   * resume UX. The metadata is informational; importing a snapshot does
   * not auto-switch provider/model.
   */
  exportSession(): string {
    const state = this.contextManager.getConversationState();
    const metadata: SessionMetadata = {
      providerName: this.provider.name,
      modelKey: this.model,
      systemPrompt: this.systemPrompt,
      promptBudgetPolicy: DEFAULT_BUDGET_POLICY,
      summaryPolicy: this.summaryPolicy,
      contextWindowTokens: this.resolveContextWindowTokens(),
    };
    return serializeSession(state, metadata);
  }

  /**
   * Import a validated snapshot into the current agent instance,
   * replacing all in-memory context state. Persisted metadata
   * (provider, model, system prompt) is preserved in the snapshot
   * for analysis but does not alter the agent's current configuration.
   *
   * Throws SessionParseError on malformed or unsupported snapshots.
   */
  importSession(json: string): void {
    const persisted = parseSession(json);
    const state = restoreConversationState(persisted);
    this.summaryGeneration++;
    this.summaryDirty = false;
    this.lastPromptPlanSnapshot = null;
    this.contextManager.importState(state);
  }

  // -------------------------------------------------------------------
  // Pinned memory (Phase 7)
  // -------------------------------------------------------------------

  pinFact(input: PinFactInput): string {
    return this.contextManager.pinFact(input);
  }

  addProjectConstraint(
    content: string,
    source: PinFactInput["source"],
    rationale?: string,
  ): string {
    return this.contextManager.addProjectConstraint(content, source, rationale);
  }

  updateMemory(id: string, input: UpdateMemoryInput): string {
    return this.contextManager.updateMemory(id, input);
  }

  unpinFact(id: string, rationale?: string): void {
    this.contextManager.unpinFact(id, rationale);
  }

  getPinnedMemory(opts?: {
    includeInactive?: boolean;
  }): ReadonlyArray<PinnedMemoryRecord> {
    return this.contextManager.getPinnedMemory(opts);
  }

  getLastTurnReasoningSummary(): TurnReasoningSummary | null {
    return this.lastTurnReasoningSummary
      ? { ...this.lastTurnReasoningSummary }
      : null;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getTools(): ChatTool[] {
    return this.toolRegistry.getEnabledSchemas();
  }

  addTool(tool: ExecutableTool): void {
    this.toolRegistry.register(tool);
  }

  removeTool(name: string): void {
    this.toolRegistry.unregister(name);
  }

  enableTool(name: string): void {
    this.toolRegistry.enable(name);
  }

  disableTool(name: string): void {
    this.toolRegistry.disable(name);
  }

  getToolNames(): string[] {
    return this.toolRegistry.getToolNames();
  }

  isToolEnabled(name: string): boolean {
    return this.toolRegistry.isToolEnabled(name);
  }

  private handleProviderError(error: any): Error {
    const providerName = this.provider.name;

    if (error instanceof ProviderAuthenticationError) {
      return new Error(
        `Provider ${providerName} authentication failed: ${error.message}`,
      );
    }

    if (error instanceof ProviderModelNotFoundError) {
      return new Error(
        `Model ${error.modelName} not found in provider ${providerName}: ${error.message}`,
      );
    }

    if (error instanceof ProviderError) {
      return new Error(`Provider ${providerName} error: ${error.message}`);
    }

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return new Error(
      `Failed to get response from ${providerName}: ${errorMessage}`,
    );
  }
}
