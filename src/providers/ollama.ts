import { Ollama, Message, Tool, ToolCall } from 'ollama';
import { LLMProvider } from './interface';
import {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ChatTool,
  ChatToolCall,
  ProviderError,
  ProviderAuthenticationError,
  ProviderModelNotFoundError
} from './types';

/**
 * Ollama implementation of LLMProvider
 */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  private ollama: Ollama;
  private model: string;

  constructor(options: { model: string; host?: string }) {
    const host = options.host || process.env.OLLAMA_HOST || 'http://localhost:11434';
    this.ollama = new Ollama({ host });
    this.model = options.model;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      const messages = request.messages.map(msg => this.chatMessageToOllamaMessage(msg));
      const tools = request.tools?.map(tool => this.chatToolToOllamaTool(tool));

      const response = await this.ollama.chat({
        model: request.model || this.model,
        messages,
        stream: false,
        ...(tools && { tools })
      });

      const stopReason = this.getStopReason(response.message);

      return {
        message: this.ollamaMessageToChatMessage(response.message),
        stopReason
      };
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    try {
      const messages = request.messages.map(msg => this.chatMessageToOllamaMessage(msg));
      const tools = request.tools?.map(tool => this.chatToolToOllamaTool(tool));

      const response = await this.ollama.chat({
        model: request.model || this.model,
        messages,
        stream: true,
        ...(tools && { tools })
      });

      let lastToolCalls: ChatToolCall[] | undefined;

      for await (const chunk of response) {
        // Yield delta content
        if (chunk.message.content) {
          yield { delta: chunk.message.content };
        }

        // Capture tool calls from the final chunk
        if (chunk.message.tool_calls) {
          lastToolCalls = chunk.message.tool_calls.map(toolCall =>
            this.ollamaToolCallToChatToolCall(toolCall)
          );
        }
      }

      // Yield final chunk with tool calls if present
      if (lastToolCalls && lastToolCalls.length > 0) {
        yield {
          delta: '',
          toolCalls: lastToolCalls
        };
      }
    } catch (error) {
      throw this.translateError(error);
    }
  }

  /**
   * Translate ChatMessage to Ollama Message format
   */
  private chatMessageToOllamaMessage(msg: ChatMessage): Message {
    const ollamaMsg: Message = {
      role: msg.role,
      content: msg.content
    };

    if (msg.toolCalls) {
      ollamaMsg.tool_calls = msg.toolCalls.map(toolCall => ({
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments
        }
      }));
    }

    if (msg.images) {
      // Handle images as mixed type array - needs casting for type compatibility
      ollamaMsg.images = msg.images as any;
    }

    return ollamaMsg;
  }

  /**
   * Translate Ollama Message to ChatMessage
   */
  private ollamaMessageToChatMessage(msg: Message): ChatMessage {
    const chatMsg: ChatMessage = {
      role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
      content: msg.content
    };

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      chatMsg.toolCalls = msg.tool_calls.map(toolCall =>
        this.ollamaToolCallToChatToolCall(toolCall)
      );
    }

    if (msg.images) {
      // Handle mixed array of strings and Uint8Array
      chatMsg.images = msg.images as (Uint8Array | string)[];
    }

    return chatMsg;
  }

  /**
   * Translate Ollama ToolCall to ChatToolCall
   */
  private ollamaToolCallToChatToolCall(toolCall: ToolCall): ChatToolCall {
    return {
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments
      }
    };
  }

  /**
   * Translate ChatTool to Ollama Tool format
   */
  private chatToolToOllamaTool(chatTool: ChatTool): Tool {
    return {
      type: chatTool.type,
      function: {
        name: chatTool.function.name,
        description: chatTool.function.description,
        parameters: chatTool.function.parameters
      }
    };
  }

  /**
   * Determine stop reason from Ollama response
   */
  private getStopReason(
    message: Message
  ): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
    if (message.tool_calls && message.tool_calls.length > 0) {
      return 'tool_use';
    }
    return 'end_turn';
  }

  /**
   * Translate errors to ProviderError types
   */
  private translateError(error: any): ProviderError {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Connection errors
    if (
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('ECONNRESET') ||
      errorMessage.includes('connect')
    ) {
      return new ProviderAuthenticationError(
        `Failed to connect to Ollama: ${errorMessage}`,
        error instanceof Error ? error : undefined
      );
    }

    // Model not found
    if (errorMessage.includes('model not found') || errorMessage.includes('pull')) {
      return new ProviderModelNotFoundError(
        this.model,
        `Model ${this.model} not found: ${errorMessage}`,
        error instanceof Error ? error : undefined
      );
    }

    // Generic error
    return new ProviderError(errorMessage, error instanceof Error ? error : undefined);
  }
}
