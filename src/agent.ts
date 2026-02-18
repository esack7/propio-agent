import * as path from "path";
import { LLMProvider } from "./providers/interface.js";
import {
  ChatMessage,
  ChatTool,
  ChatToolCall,
  ProviderError,
  ProviderAuthenticationError,
  ProviderModelNotFoundError,
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
import { ToolContext } from "./tools/types.js";
import { AgentDiagnosticEvent } from "./diagnostics.js";

export class Agent {
  private static readonly MAX_TOOL_RESULT_CHARS = 12000;
  private static readonly MAX_EMPTY_TOOL_ONLY_STREAK = 3;
  private provider: LLMProvider;
  private model: string;
  private sessionContext: ChatMessage[];
  private systemPrompt: string;
  private sessionContextFilePath: string;
  private toolRegistry: ToolRegistry;
  private providersConfig: ProvidersConfig;
  private diagnosticsEnabled: boolean;
  private diagnosticsListener?: (event: AgentDiagnosticEvent) => void;

  /**
   * Initialize an Agent with multi-provider configuration.
   *
   * The Agent orchestrates interactions with an LLM provider. It maintains session context,
   * manages tools, and handles both regular and streaming chat interactions. Provider instances
   * are created using the factory pattern, allowing new providers to be supported without
   * modifying the Agent class.
   *
   * @param options - Configuration options for the agent
   * @param options.providersConfig - Multi-provider configuration (ProvidersConfig object or file path string).
   *                                  Required - will throw an error if not provided.
   * @param options.providerName - Optional provider name to use. If not provided, uses config.default
   * @param options.modelKey - Optional model key to use. If not provided, uses provider.defaultModel
   * @param options.systemPrompt - System prompt to use in all LLM requests. Defaults to a generic helpful assistant prompt.
   * @param options.sessionContextFilePath - Path to persist session context. Defaults to './session_context.txt'.
   *
   * @example
   * // Use default provider from config file
   * const agent = new Agent({
   *   providersConfig: './providers.json'
   * });
   *
   * @example
   * // Use specific provider and model with inline config
   * const agent = new Agent({
   *   providersConfig: {
   *     default: 'ollama',
   *     providers: [
   *       {
   *         name: 'ollama',
   *         type: 'ollama',
   *         models: [{ name: 'Llama', key: 'llama3.2' }],
   *         defaultModel: 'llama3.2'
   *       }
   *     ]
   *   },
   *   providerName: 'ollama',
   *   modelKey: 'llama3.2',
   *   systemPrompt: 'You are a helpful coding assistant.'
   * });
   */
  constructor(
    options: {
      providersConfig: ProvidersConfig | string;
      providerName?: string;
      modelKey?: string;
      systemPrompt?: string;
      sessionContextFilePath?: string;
      agentsMdContent?: string;
      diagnosticsEnabled?: boolean;
      onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;
    } = {} as any,
  ) {
    // Validate required providersConfig
    if (!options.providersConfig) {
      throw new Error(
        "Provider configuration is required. Please provide a providersConfig option with provider settings.",
      );
    }

    const basePrompt =
      options.systemPrompt || "You are a helpful AI assistant.";

    // Prepend agentsMdContent if provided and non-empty
    if (options.agentsMdContent) {
      this.systemPrompt = `${options.agentsMdContent}\n\n${basePrompt}`;
    } else {
      this.systemPrompt = basePrompt;
    }
    this.sessionContextFilePath =
      options.sessionContextFilePath ||
      path.join(process.cwd(), "session_context.txt");

    // Load configuration from file if string path provided, otherwise use directly
    let config: ProvidersConfig;
    if (typeof options.providersConfig === "string") {
      config = loadProvidersConfig(options.providersConfig);
    } else {
      config = options.providersConfig;
    }

    this.providersConfig = config;
    this.diagnosticsEnabled = options.diagnosticsEnabled ?? false;
    this.diagnosticsListener = options.onDiagnosticEvent;

    // Resolve provider from config
    const resolvedProvider = resolveProvider(config, options.providerName);

    // Resolve model key from provider
    const resolvedModelKey = resolveModelKey(
      resolvedProvider,
      options.modelKey,
    );

    // Create provider instance using factory
    this.provider = createProvider(resolvedProvider, resolvedModelKey);
    this.model = resolvedModelKey;

    this.sessionContext = [];

    // Create ToolContext using property getters for live state access
    const self = this;
    const toolContext: ToolContext = {
      get systemPrompt() {
        return self.systemPrompt;
      },
      get sessionContext() {
        return self.sessionContext;
      },
      get sessionContextFilePath() {
        return self.sessionContextFilePath;
      },
    };

    this.toolRegistry = createDefaultToolRegistry(toolContext);
  }

  private emitDiagnostic(event: AgentDiagnosticEvent): void {
    if (!this.diagnosticsEnabled || !this.diagnosticsListener) {
      return;
    }
    this.diagnosticsListener(event);
  }

  /**
   * Switch to a different provider at runtime
   *
   * @param providerName - Name of provider to switch to (from providersConfig)
   * @param modelKey - Optional model key to use in the new provider. Uses provider.defaultModel if not specified.
   * @throws Error if provider name or model key is not found in configuration
   */
  private switchProvider(providerName: string, modelKey?: string): void {
    // Resolve and validate provider from stored config
    const resolvedProvider = resolveProvider(
      this.providersConfig,
      providerName,
    );

    // Resolve and validate model key
    const resolvedModelKey = resolveModelKey(resolvedProvider, modelKey);

    // Create new provider instance
    const newProvider = createProvider(resolvedProvider, resolvedModelKey);

    // Update provider and model
    this.provider = newProvider;
    this.model = resolvedModelKey;
  }

  /**
   * Keep tool outputs bounded before feeding them back to the model.
   * Large payloads can starve the follow-up completion and yield empty responses.
   */
  private sanitizeToolResultForContext(result: string): string {
    if (result.length <= Agent.MAX_TOOL_RESULT_CHARS) {
      return result;
    }

    const truncated = result.substring(0, Agent.MAX_TOOL_RESULT_CHARS);
    const omittedChars = result.length - Agent.MAX_TOOL_RESULT_CHARS;
    return `${truncated}\n\n[tool output truncated: omitted ${omittedChars} chars]`;
  }

  private async requestFinalResponseWithoutTools(
    onToken: (token: string) => void,
    abortSignal: AbortSignal | undefined,
    iteration: number,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...this.sessionContext,
      {
        role: "user",
        content:
          "Do not call tools. Provide the best final answer from the gathered context. If context is insufficient, explain what is missing briefly.",
      },
    ];

    this.emitDiagnostic({
      type: "request_started",
      provider: this.provider.name,
      model: this.model,
      iteration,
      contextMessages: messages.length,
      enabledTools: 0,
    });

    let fullResponse = "";
    let chunkCount = 0;
    for await (const chunk of this.provider.streamChat({
      model: this.model,
      messages,
      signal: abortSignal,
    })) {
      if (abortSignal?.aborted) {
        throw new Error("Request cancelled");
      }

      const token = chunk.delta;
      fullResponse += token;
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
      if (token) {
        onToken(token);
      }
    }

    this.sessionContext.push({
      role: "assistant",
      content: fullResponse,
    });
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
        contextMessages: this.sessionContext.length,
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
      abortSignal?: AbortSignal;
    },
  ): Promise<string> {
    if (options?.abortSignal?.aborted) {
      throw new Error("Request cancelled");
    }

    this.sessionContext.push({
      role: "user",
      content: userMessage,
    });

    let iterationCount = 0;
    try {
      let finalResponse = "";
      let continueLoop = true;
      const maxIterations = 10; // Prevent infinite loops
      let emptyToolOnlyStreak = 0;

      while (continueLoop && iterationCount < maxIterations) {
        iterationCount++;

        const messages: ChatMessage[] = [
          { role: "system", content: this.systemPrompt },
          ...this.sessionContext,
        ];
        this.emitDiagnostic({
          type: "request_started",
          provider: this.provider.name,
          model: this.model,
          iteration: iterationCount,
          contextMessages: messages.length,
          enabledTools: this.toolRegistry.getEnabledSchemas().length,
        });

        let fullResponse = "";
        let toolCalls: ChatToolCall[] | undefined;
        let chunkCount = 0;

        for await (const chunk of this.provider.streamChat({
          model: this.model,
          messages: messages,
          tools: this.toolRegistry.getEnabledSchemas(),
          signal: options?.abortSignal,
        })) {
          if (options?.abortSignal?.aborted) {
            throw new Error("Request cancelled");
          }

          const token = chunk.delta;
          fullResponse += token;
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

          // Capture tool calls from chunks
          if (chunk.toolCalls) {
            toolCalls = chunk.toolCalls;
          }
        }

        const normalizedToolCalls = toolCalls?.map((toolCall, index) => ({
          ...toolCall,
          id: toolCall.id || `toolcall_${iterationCount}_${index}`,
        }));
        if (normalizedToolCalls && normalizedToolCalls.length > 0) {
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

        this.sessionContext.push({
          role: "assistant",
          content: fullResponse,
          toolCalls: normalizedToolCalls,
        });
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
            contextMessages: this.sessionContext.length,
          });
        }

        finalResponse = fullResponse;

        const toolCallsToExecute = normalizedToolCalls ?? [];
        const hasToolCalls = toolCallsToExecute.length > 0;
        const isEmptyResponse = fullResponse.trim().length === 0;
        emptyToolOnlyStreak =
          hasToolCalls && isEmptyResponse ? emptyToolOnlyStreak + 1 : 0;

        // Handle tool calls if present
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

            // Remove the latest assistant tool-call message before fallback finalization.
            // It has unresolved tool calls that can keep the model in a loop.
            this.sessionContext.pop();

            finalResponse = await this.requestFinalResponseWithoutTools(
              onToken,
              options?.abortSignal,
              iterationCount + 1,
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
          const toolResults = [];

          for (const toolCall of toolCallsToExecute) {
            if (options?.abortSignal?.aborted) {
              throw new Error("Request cancelled");
            }

            const args = toolCall.function.arguments;
            const toolName = toolCall.function.name;
            const serializedArgs = JSON.stringify(args ?? {});
            const toolCallId = toolCall.id!;
            this.emitDiagnostic({
              type: "tool_execution_started",
              provider: this.provider.name,
              model: this.model,
              iteration: iterationCount,
              toolName,
              toolCallId,
              argsChars: serializedArgs.length,
            });

            // Invoke onToolStart callback if provided, otherwise use onToken
            if (options?.onToolStart) {
              options.onToolStart(toolName);
            } else {
              onToken(`[Executing tool: ${toolName}]\n`);
            }

            const result = await this.toolRegistry.execute(toolName, args);
            const contextSafeResult = this.sanitizeToolResultForContext(result);
            this.emitDiagnostic({
              type: "tool_execution_finished",
              provider: this.provider.name,
              model: this.model,
              iteration: iterationCount,
              toolName,
              toolCallId,
              resultChars: result.length,
              truncatedForContext: contextSafeResult.length < result.length,
            });

            toolResults.push({
              toolCallId,
              toolName: toolName,
              content: contextSafeResult,
            });

            // Invoke onToolEnd callback if provided, otherwise use onToken
            if (options?.onToolEnd) {
              options.onToolEnd(toolName, result);
            } else {
              onToken(
                `[Tool result: ${result.substring(0, 100)}${result.length > 100 ? "..." : ""}]\n`,
              );
            }
          }

          // Add single message with all tool results batched together
          this.sessionContext.push({
            role: "tool",
            content: "", // Empty content, actual results are in toolResults array
            toolResults: toolResults,
          });

          onToken("\n");
          // Continue loop to let agent process tool results
        } else {
          // No tool calls, we're done
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
    this.sessionContext = [];
  }

  getContext(): ChatMessage[] {
    return [...this.sessionContext];
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getTools(): ChatTool[] {
    return this.toolRegistry.getEnabledSchemas();
  }

  async saveContext(reason?: string): Promise<string> {
    return await this.toolRegistry.execute("save_session_context", { reason });
  }

  /**
   * Add a custom tool to the agent at runtime.
   * The tool is registered and enabled by default.
   *
   * @param tool - ExecutableTool implementation to add
   */
  addTool(tool: ExecutableTool): void {
    this.toolRegistry.register(tool);
  }

  /**
   * Remove a tool from the agent at runtime.
   * Idempotent - removing a nonexistent tool has no effect.
   *
   * @param name - Name of the tool to remove
   */
  removeTool(name: string): void {
    this.toolRegistry.unregister(name);
  }

  /**
   * Enable a tool, making it available for LLM requests.
   *
   * @param name - Name of the tool to enable
   */
  enableTool(name: string): void {
    this.toolRegistry.enable(name);
  }

  /**
   * Disable a tool, excluding it from LLM requests.
   * The tool remains registered and can be re-enabled later.
   *
   * @param name - Name of the tool to disable
   */
  disableTool(name: string): void {
    this.toolRegistry.disable(name);
  }

  /**
   * Get names of all registered tools in registration order.
   *
   * @returns Array of tool names (both enabled and disabled)
   */
  getToolNames(): string[] {
    return this.toolRegistry.getToolNames();
  }

  /**
   * Check if a tool is registered and enabled.
   *
   * @param name - The name of the tool to check
   * @returns true if the tool is registered and enabled, false otherwise
   */
  isToolEnabled(name: string): boolean {
    return this.toolRegistry.isToolEnabled(name);
  }

  /**
   * Handle and translate provider errors to meaningful messages
   */
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
