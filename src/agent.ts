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
import { ProviderConfig } from './providers/config';
import { OllamaProvider } from './providers/ollama';

export class Agent {
  private provider: LLMProvider;
  private model: string;
  private sessionContext: ChatMessage[];
  private systemPrompt: string;
  private sessionContextFilePath: string;
  private tools: ChatTool[];

  constructor(options: {
    model?: string;
    host?: string;
    systemPrompt?: string;
    sessionContextFilePath?: string;
    providerConfig?: ProviderConfig;
  } = {}) {
    this.systemPrompt = options.systemPrompt || 'You are a helpful AI assistant.';
    this.sessionContextFilePath = options.sessionContextFilePath || path.join(process.cwd(), 'session_context.txt');

    // Initialize provider based on configuration
    if (options.providerConfig) {
      this.provider = this.createProvider(options.providerConfig);
      this.model = this.getModelFromConfig(options.providerConfig) || 'qwen3-coder:30b';
    } else {
      // Backward compatibility: use legacy options to create Ollama provider
      this.model = options.model || 'qwen3-coder:30b';
      const host = options.host || process.env.OLLAMA_HOST || 'http://localhost:11434';
      this.provider = new OllamaProvider({ model: this.model, host });
    }

    this.sessionContext = [];
    this.tools = this.initializeTools();
  }

  /**
   * Extract model from config based on provider type
   */
  private getModelFromConfig(config: ProviderConfig): string | undefined {
    if (config.provider === 'ollama') {
      return (config as any).ollama?.model;
    } else if (config.provider === 'bedrock') {
      return (config as any).bedrock?.model;
    }
    return undefined;
  }

  /**
   * Create provider from config
   */
  private createProvider(config: ProviderConfig): LLMProvider {
    if (config.provider === 'ollama') {
      const ollamaConfig = config as any;
      return new OllamaProvider({
        model: ollamaConfig.ollama.model,
        host: ollamaConfig.ollama.host
      });
    } else if (config.provider === 'bedrock') {
      throw new Error('Bedrock provider not yet implemented');
    }
    throw new Error(`Unknown provider: ${(config as any).provider}`);
  }

  /**
   * Switch to a different provider
   */
  private switchProvider(config: ProviderConfig): void {
    const newProvider = this.createProvider(config);
    this.provider = newProvider;
    // Update model if specified in config
    this.model = this.getModelFromConfig(config) || this.model;
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
