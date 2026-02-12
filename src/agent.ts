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

export class Agent {
  private provider: LLMProvider;
  private model: string;
  private sessionContext: ChatMessage[];
  private systemPrompt: string;
  private sessionContextFilePath: string;
  private toolRegistry: ToolRegistry;
  private providersConfig: ProvidersConfig;

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
    } = {} as any,
  ) {
    // Validate required providersConfig
    if (!options.providersConfig) {
      throw new Error(
        "Provider configuration is required. Please provide a providersConfig option with provider settings.",
      );
    }

    this.systemPrompt =
      options.systemPrompt || "You are a helpful AI assistant.";
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

  async streamChat(
    userMessage: string,
    onToken: (token: string) => void,
    options?: {
      onToolStart?: (toolName: string) => void;
      onToolEnd?: (toolName: string, result: string) => void;
    },
  ): Promise<string> {
    this.sessionContext.push({
      role: "user",
      content: userMessage,
    });

    try {
      let finalResponse = "";
      let continueLoop = true;
      let iterationCount = 0;
      const maxIterations = 10; // Prevent infinite loops

      while (continueLoop && iterationCount < maxIterations) {
        iterationCount++;

        const messages: ChatMessage[] = [
          { role: "system", content: this.systemPrompt },
          ...this.sessionContext,
        ];

        let fullResponse = "";
        let toolCalls: ChatToolCall[] | undefined;

        for await (const chunk of this.provider.streamChat({
          model: this.model,
          messages: messages,
          tools: this.toolRegistry.getEnabledSchemas(),
        })) {
          const token = chunk.delta;
          fullResponse += token;
          if (token) {
            onToken(token);
          }

          // Capture tool calls from chunks
          if (chunk.toolCalls) {
            toolCalls = chunk.toolCalls;
          }
        }

        this.sessionContext.push({
          role: "assistant",
          content: fullResponse,
          toolCalls: toolCalls,
        });

        finalResponse = fullResponse;

        // Handle tool calls if present
        if (toolCalls && toolCalls.length > 0) {
          onToken("\n");
          const toolResults = [];

          for (const toolCall of toolCalls) {
            const args = toolCall.function.arguments;
            const toolName = toolCall.function.name;

            // Invoke onToolStart callback if provided, otherwise use onToken
            if (options?.onToolStart) {
              options.onToolStart(toolName);
            } else {
              onToken(`[Executing tool: ${toolName}]\n`);
            }

            const result = await this.toolRegistry.execute(toolName, args);

            toolResults.push({
              toolCallId:
                toolCall.id || `${toolCall.function.name}-${Date.now()}`,
              toolName: toolName,
              content: result,
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

      return finalResponse;
    } catch (error) {
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
