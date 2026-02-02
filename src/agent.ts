import { Ollama, Message, Tool, ToolCall } from 'ollama';
import * as fs from 'fs';
import * as path from 'path';

export class Agent {
  private ollama: Ollama;
  private model: string;
  private sessionContext: Message[];
  private systemPrompt: string;
  private sessionContextFilePath: string;
  private tools: Tool[];

  constructor(options: {
    model?: string;
    host?: string;
    systemPrompt?: string;
    sessionContextFilePath?: string;
  } = {}) {
    this.model = options.model || 'qwen3-coder:30b';
    this.ollama = new Ollama({
      host: options.host || process.env.OLLAMA_HOST || 'http://localhost:11434'
    });
    this.systemPrompt = options.systemPrompt || 'You are a helpful AI assistant.';
    this.sessionContext = [];
    this.sessionContextFilePath = options.sessionContextFilePath || path.join(process.cwd(), 'session_context.txt');
    this.tools = this.initializeTools();
  }

  private initializeTools(): Tool[] {
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

        const messages: Message[] = [
          { role: 'system', content: this.systemPrompt },
          ...this.sessionContext
        ];

        const response = await this.ollama.chat({
          model: this.model,
          messages: messages,
          stream: false,
          tools: this.tools
        });

        const assistantMessage = response.message.content;
        const toolCalls = response.message.tool_calls;

        this.sessionContext.push({
          role: 'assistant',
          content: assistantMessage,
          tool_calls: toolCalls
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get response from Ollama: ${errorMessage}`);
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

        const messages: Message[] = [
          { role: 'system', content: this.systemPrompt },
          ...this.sessionContext
        ];

        const response = await this.ollama.chat({
          model: this.model,
          messages: messages,
          stream: true,
          tools: this.tools
        });

        let fullResponse = '';
        let toolCalls: ToolCall[] | undefined;

        for await (const part of response) {
          const token = part.message.content;
          fullResponse += token;
          onToken(token);

          // Capture tool calls from the final part
          if (part.message.tool_calls) {
            toolCalls = part.message.tool_calls;
          }
        }

        this.sessionContext.push({
          role: 'assistant',
          content: fullResponse,
          tool_calls: toolCalls
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get response from Ollama: ${errorMessage}`);
    }
  }

  clearContext(): void {
    this.sessionContext = [];
  }

  getContext(): Message[] {
    return [...this.sessionContext];
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getTools(): Tool[] {
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
}
