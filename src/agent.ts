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
} from "./providers/types.js";
import { ProvidersConfig } from "./providers/config.js";
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
import { ArtifactToolResult } from "./context/types.js";

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
    };

export interface TurnReasoningSummary {
  summary: string;
  source: ProviderReasoningSummarySource;
}

export class Agent {
  private static readonly MAX_EMPTY_TOOL_ONLY_STREAK = 3;
  private static readonly MAX_VISIBILITY_PREVIEW_CHARS = 120;
  private provider: LLMProvider;
  private model: string;
  private contextManager: ContextManager;
  private systemPrompt: string;
  private toolRegistry: ToolRegistry;
  private providersConfig: ProvidersConfig;
  private diagnosticsEnabled: boolean;
  private diagnosticsListener?: (event: AgentDiagnosticEvent) => void;
  private lastTurnReasoningSummary: TurnReasoningSummary | null = null;

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

    this.provider = createProvider(resolvedProvider, resolvedModelKey);
    this.model = resolvedModelKey;

    this.contextManager = new ContextManager();
    this.toolRegistry = createDefaultToolRegistry();
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

    this.provider = newProvider;
    this.model = resolvedModelKey;
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
    const plan = this.contextManager.buildPromptPlan(
      this.systemPrompt,
      noToolsInstruction,
    );
    const messages = plan.messages as ChatMessage[];

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
      reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
    });

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
  }

  async streamChat(
    userMessage: string,
    onToken: (token: string) => void,
    options?: {
      onToolStart?: (toolName: string) => void;
      onToolEnd?: (toolName: string, result: string) => void;
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
    const toolExecutionEvents: Array<{ name: string; failed: boolean }> = [];
    let providerReasoningSummary: TurnReasoningSummary | null = null;
    try {
      let finalResponse = "";
      let continueLoop = true;
      const maxIterations = 10;
      let emptyToolOnlyStreak = 0;

      while (continueLoop && iterationCount < maxIterations) {
        iterationCount++;

        const plan = this.contextManager.buildPromptPlan(this.systemPrompt);
        const messages = plan.messages as ChatMessage[];
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
          reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
        });

        let fullResponse = "";
        let toolCalls: ChatToolCall[] | undefined;
        let chunkCount = 0;
        this.emitStatus(options, "Streaming response", "response");

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
              options.onToolEnd(toolName, result);
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
    this.contextManager.clear();
  }

  getContext(): ChatMessage[] {
    return this.contextManager.getSnapshot();
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
