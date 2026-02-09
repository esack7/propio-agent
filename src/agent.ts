import * as fs from 'fs';
import * as path from 'path';
import { LLMProvider } from './providers/interface';
import {
  ChatMessage,
  ChatTool,
  ChatToolCall,
  ProviderError,
  ProviderAuthenticationError,
  ProviderModelNotFoundError
} from './providers/types';
import { ProvidersConfig, ProviderConfig } from './providers/config';
import { createProvider } from './providers/factory';
import { loadProvidersConfig, resolveProvider, resolveModelKey } from './providers/configLoader';

export class Agent {
  private provider: LLMProvider;
  private model: string;
  private sessionContext: ChatMessage[];
  private systemPrompt: string;
  private sessionContextFilePath: string;
  private tools: ChatTool[];
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
  constructor(options: {
    providersConfig: ProvidersConfig | string;
    providerName?: string;
    modelKey?: string;
    systemPrompt?: string;
    sessionContextFilePath?: string;
  } = {} as any) {
    // Validate required providersConfig
    if (!options.providersConfig) {
      throw new Error('Provider configuration is required. Please provide a providersConfig option with provider settings.');
    }

    this.systemPrompt = options.systemPrompt || 'You are a helpful AI assistant.';
    this.sessionContextFilePath = options.sessionContextFilePath || path.join(process.cwd(), 'session_context.txt');

    // Load configuration from file if string path provided, otherwise use directly
    let config: ProvidersConfig;
    if (typeof options.providersConfig === 'string') {
      config = loadProvidersConfig(options.providersConfig);
    } else {
      config = options.providersConfig;
    }

    this.providersConfig = config;

    // Resolve provider from config
    const resolvedProvider = resolveProvider(config, options.providerName);

    // Resolve model key from provider
    const resolvedModelKey = resolveModelKey(resolvedProvider, options.modelKey);

    // Create provider instance using factory
    this.provider = createProvider(resolvedProvider, resolvedModelKey);
    this.model = resolvedModelKey;

    this.sessionContext = [];
    this.tools = this.initializeTools();
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
    const resolvedProvider = resolveProvider(this.providersConfig, providerName);

    // Resolve and validate model key
    const resolvedModelKey = resolveModelKey(resolvedProvider, modelKey);

    // Create new provider instance
    const newProvider = createProvider(resolvedProvider, resolvedModelKey);

    // Update provider and model
    this.provider = newProvider;
    this.model = resolvedModelKey;
  }

  private initializeTools(): ChatTool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'save_session_context',
          description: 'Saves the current session context to a file. Call this after completing tasks to persist the session state.',
          parameters: {
            type: 'object',
            properties: {
              reason: {
                type: 'string',
                description: 'Optional reason for saving the session context'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Reads the content of a file from the filesystem',
          parameters: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'The path to the file to read'
              }
            },
            required: ['file_path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Writes content to a file on the filesystem',
          parameters: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'The path to the file to write'
              },
              content: {
                type: 'string',
                description: 'The content to write to the file'
              }
            },
            required: ['file_path', 'content']
          }
        }
      }
    ];
  }

  async chat(userMessage: string): Promise<string> {
    this.sessionContext.push({
      role: 'user',
      content: userMessage
    });

    try {
      let finalResponse = '';
      let continueLoop = true;
      let iterationCount = 0;
      const maxIterations = 10; // Prevent infinite loops

      while (continueLoop && iterationCount < maxIterations) {
        iterationCount++;

        const messages: ChatMessage[] = [
          { role: 'system', content: this.systemPrompt },
          ...this.sessionContext
        ];

        const response = await this.provider.chat({
          model: this.model,
          messages: messages,
          tools: this.tools
        });

        const assistantMessage = response.message.content;
        const toolCalls = response.message.toolCalls;

        this.sessionContext.push({
          role: 'assistant',
          content: assistantMessage,
          toolCalls: toolCalls
        });

        finalResponse = assistantMessage;

        // Handle tool calls if present
        if (toolCalls && toolCalls.length > 0) {
          for (const toolCall of toolCalls) {
            const args = toolCall.function.arguments;
            const result = this.executeTool(toolCall.function.name, args);

            this.sessionContext.push({
              role: 'tool',
              content: result
            });
          }
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

  async streamChat(userMessage: string, onToken: (token: string) => void): Promise<string> {
    this.sessionContext.push({
      role: 'user',
      content: userMessage
    });

    try {
      let finalResponse = '';
      let continueLoop = true;
      let iterationCount = 0;
      const maxIterations = 10; // Prevent infinite loops

      while (continueLoop && iterationCount < maxIterations) {
        iterationCount++;

        const messages: ChatMessage[] = [
          { role: 'system', content: this.systemPrompt },
          ...this.sessionContext
        ];

        let fullResponse = '';
        let toolCalls: ChatToolCall[] | undefined;

        for await (const chunk of this.provider.streamChat({
          model: this.model,
          messages: messages,
          tools: this.tools
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
          role: 'assistant',
          content: fullResponse,
          toolCalls: toolCalls
        });

        finalResponse = fullResponse;

        // Handle tool calls if present
        if (toolCalls && toolCalls.length > 0) {
          onToken('\n');
          for (const toolCall of toolCalls) {
            const args = toolCall.function.arguments;
            const toolName = toolCall.function.name;

            onToken(`[Executing tool: ${toolName}]\n`);
            const result = this.executeTool(toolName, args);

            this.sessionContext.push({
              role: 'tool',
              content: result
            });

            onToken(`[Tool result: ${result.substring(0, 100)}${result.length > 100 ? '...' : ''}]\n`);
          }
          onToken('\n');
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
    return [...this.tools];
  }

  saveContext(reason?: string): string {
    return this.executeTool('save_session_context', { reason });
  }

  private executeTool(toolName: string, args: any): string {
    try {
      switch (toolName) {
        case 'save_session_context': {
          let content = `=== Session Context ===\n`;
          content += `System Prompt: ${this.systemPrompt}\n`;
          content += `Saved at: ${new Date().toISOString()}\n`;
          if (args.reason) {
            content += `Reason: ${args.reason}\n`;
          }
          content += '\n';

          if (this.sessionContext.length === 0) {
            content += 'No session context.\n';
          } else {
            this.sessionContext.forEach((msg, index) => {
              content += `[${index + 1}] ${msg.role.toUpperCase()}:\n${msg.content}\n\n`;
            });
          }

          fs.writeFileSync(this.sessionContextFilePath, content, 'utf-8');
          return `Successfully saved session context to ${this.sessionContextFilePath}`;
        }

        case 'read_file': {
          const filePath = args.file_path;
          const content = fs.readFileSync(filePath, 'utf-8');
          return content;
        }

        case 'write_file': {
          const filePath = args.file_path;
          const content = args.content;
          fs.writeFileSync(filePath, content, 'utf-8');
          return `Successfully wrote to ${filePath}`;
        }

        default:
          return `Unknown tool: ${toolName}`;
      }
    } catch (error) {
      return `Error executing tool ${toolName}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Handle and translate provider errors to meaningful messages
   */
  private handleProviderError(error: any): Error {
    const providerName = this.provider.name;

    if (error instanceof ProviderAuthenticationError) {
      return new Error(`Provider ${providerName} authentication failed: ${error.message}`);
    }

    if (error instanceof ProviderModelNotFoundError) {
      return new Error(
        `Model ${error.modelName} not found in provider ${providerName}: ${error.message}`
      );
    }

    if (error instanceof ProviderError) {
      return new Error(`Provider ${providerName} error: ${error.message}`);
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Error(`Failed to get response from ${providerName}: ${errorMessage}`);
  }
}
