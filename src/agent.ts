import { Ollama, Message, Tool, ToolCall } from 'ollama';
import * as fs from 'fs';
import * as path from 'path';

export class Agent {
  private ollama: Ollama;
  private model: string;
  private conversationHistory: Message[];
  private systemPrompt: string;
  private historyFilePath: string;
  private tools: Tool[];

  constructor(options: {
    model?: string;
    host?: string;
    systemPrompt?: string;
    historyFilePath?: string;
  } = {}) {
    this.model = options.model || 'qwen3-coder:30b';
    this.ollama = new Ollama({
      host: options.host || process.env.OLLAMA_HOST || 'http://localhost:11434'
    });
    this.systemPrompt = options.systemPrompt || 'You are a helpful AI assistant.';
    this.conversationHistory = [];
    this.historyFilePath = options.historyFilePath || path.join(process.cwd(), 'history.txt');
    this.tools = this.initializeTools();
  }

  private initializeTools(): Tool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'save_history',
          description: 'Saves the current conversation history to a file. Call this after each conversation exchange to persist the chat history.',
          parameters: {
            type: 'object',
            properties: {
              reason: {
                type: 'string',
                description: 'Optional reason for saving the history'
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
    this.conversationHistory.push({
      role: 'user',
      content: userMessage
    });

    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      ...this.conversationHistory
    ];

    try {
      const response = await this.ollama.chat({
        model: this.model,
        messages: messages,
        stream: false,
        tools: this.tools
      });

      const assistantMessage = response.message.content;
      const toolCalls = response.message.tool_calls;

      this.conversationHistory.push({
        role: 'assistant',
        content: assistantMessage,
        tool_calls: toolCalls
      });

      // Handle tool calls if present
      if (toolCalls && toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          const args = toolCall.function.arguments;
          const result = this.executeTool(toolCall.function.name, args);

          this.conversationHistory.push({
            role: 'tool',
            content: result
          });
        }
      }

      return assistantMessage;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get response from Ollama: ${errorMessage}`);
    }
  }

  async streamChat(userMessage: string, onToken: (token: string) => void): Promise<string> {
    this.conversationHistory.push({
      role: 'user',
      content: userMessage
    });

    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      ...this.conversationHistory
    ];

    try {
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

      this.conversationHistory.push({
        role: 'assistant',
        content: fullResponse,
        tool_calls: toolCalls
      });

      // Handle tool calls if present
      if (toolCalls && toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          const args = toolCall.function.arguments;
          const result = this.executeTool(toolCall.function.name, args);

          this.conversationHistory.push({
            role: 'tool',
            content: result
          });

          // Notify user about tool execution
          onToken(`\n[Tool: ${toolCall.function.name} executed]\n`);
        }
      }

      return fullResponse;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get response from Ollama: ${errorMessage}`);
    }
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }

  getHistory(): Message[] {
    return [...this.conversationHistory];
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getTools(): Tool[] {
    return [...this.tools];
  }

  private executeTool(toolName: string, args: any): string {
    try {
      switch (toolName) {
        case 'save_history': {
          let content = `=== Conversation History ===\n`;
          content += `System Prompt: ${this.systemPrompt}\n`;
          content += `Saved at: ${new Date().toISOString()}\n`;
          if (args.reason) {
            content += `Reason: ${args.reason}\n`;
          }
          content += '\n';

          if (this.conversationHistory.length === 0) {
            content += 'No conversation history.\n';
          } else {
            this.conversationHistory.forEach((msg, index) => {
              if (msg.role !== 'tool') {
                content += `[${index + 1}] ${msg.role.toUpperCase()}:\n${msg.content}\n\n`;
              }
            });
          }

          fs.writeFileSync(this.historyFilePath, content, 'utf-8');
          return `Successfully saved conversation history to ${this.historyFilePath}`;
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
