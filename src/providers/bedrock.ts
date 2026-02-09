import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand
} from '@aws-sdk/client-bedrock-runtime';
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
  ProviderRateLimitError,
  ProviderModelNotFoundError
} from './types';

/**
 * Bedrock implementation of LLMProvider
 */
export class BedrockProvider implements LLMProvider {
  readonly name = 'bedrock';
  private client: BedrockRuntimeClient;
  private model: string;

  constructor(options: { model: string; region?: string }) {
    const region = options.region || 'us-east-1';
    this.client = new BedrockRuntimeClient({ region });
    this.model = options.model;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      // Extract system message if present
      const systemMessage = request.messages.find(m => m.role === 'system');
      const otherMessages = request.messages.filter(m => m.role !== 'system');

      // Convert messages to Bedrock format
      const messages = otherMessages.map(msg =>
        this.chatMessageToBedrockMessage(msg)
      );

      // Convert tools to Bedrock format if provided
      const toolConfig = request.tools
        ? {
            tools: request.tools.map(tool => this.chatToolToBedrockTool(tool))
          }
        : undefined;


      // System message needs to be converted to SystemContentBlock format
      const systemContent = systemMessage
        ? [{ text: systemMessage.content }]
        : undefined;

      const command = new ConverseCommand({
        modelId: request.model || this.model,
        messages: messages as any,
        system: systemContent as any,
        toolConfig: toolConfig as any
      });

      const response = await this.client.send(command);

      const message = response.output?.message;
      if (!message) {
        throw new Error('No message in response');
      }

      const chatMessage = this.bedrockMessageToChatMessage(message);
      const stopReason = this.mapStopReason(response.stopReason);

      return {
        message: chatMessage,
        stopReason
      };
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    try {
      // Extract system message if present
      const systemMessage = request.messages.find(m => m.role === 'system');
      const otherMessages = request.messages.filter(m => m.role !== 'system');

      // Convert messages to Bedrock format
      const messages = otherMessages.map(msg =>
        this.chatMessageToBedrockMessage(msg)
      );

      // Convert tools to Bedrock format if provided
      const toolConfig = request.tools
        ? {
            tools: request.tools.map(tool => this.chatToolToBedrockTool(tool))
          }
        : undefined;

      // System message needs to be converted to SystemContentBlock format
      const systemContent = systemMessage
        ? [{ text: systemMessage.content }]
        : undefined;

      const command = new ConverseStreamCommand({
        modelId: request.model || this.model,
        messages: messages as any,
        system: systemContent as any,
        toolConfig: toolConfig as any
      });

      const response = await this.client.send(command);
      let stream = (response as any).stream || (response as any).output;

      // Handle case where response itself is an async iterable
      if (!stream && typeof response === 'object' && Symbol.asyncIterator in response) {
        stream = response;
      }

      if (!stream) {
        throw new Error('No stream output');
      }

      let toolCalls: ChatToolCall[] = [];
      let currentToolCall: Partial<ChatToolCall> | null = null;
      let currentToolInput = '';

      for await (const event of stream as any) {
        if (event.contentBlockDelta) {
          const delta = event.contentBlockDelta.delta;

          // Handle text delta
          if ((delta as any).text) {
            yield { delta: (delta as any).text };
          }

          // Handle tool use delta - accumulate tool input
          if ((delta as any).toolUse) {
            const partialInput = (delta as any).toolUse.input;
            if (partialInput) {
              currentToolInput += partialInput;
            }
          }
        }

        if (event.contentBlockStart) {
          // In Bedrock streaming, tool use info is in event.contentBlockStart.start.toolUse
          const toolUse = event.contentBlockStart.start?.toolUse;
          if (toolUse) {
            currentToolCall = {
              id: toolUse.toolUseId, // Capture toolUseId for later reference
              function: {
                name: toolUse.name,
                arguments: {}
              }
            };
            currentToolInput = '';
          }
        }

        if (event.contentBlockStop) {
          // Tool call completed, parse the accumulated input
          if (currentToolCall && currentToolCall.function && currentToolInput) {
            try {
              currentToolCall.function.arguments = JSON.parse(currentToolInput);
            } catch {
              currentToolCall.function.arguments = { raw: currentToolInput };
            }
            toolCalls.push(currentToolCall as ChatToolCall);
            currentToolCall = null;
            currentToolInput = '';
          }
        }
      }

      // Yield final chunk with tool calls if any
      if (toolCalls.length > 0) {
        yield {
          delta: '',
          toolCalls
        };
      }
    } catch (error) {
      throw this.translateError(error);
    }
  }

  /**
   * Check if a message is a system message
   */
  private isSystemMessage(msg: ChatMessage): boolean {
    return msg.role === 'system';
  }

  /**
   * Translate ChatMessage to Bedrock Message format
   */
  private chatMessageToBedrockMessage(msg: ChatMessage): any {
    const contentBlocks: any[] = [];

    // Add text content (but not for tool role messages - they use toolResult instead)
    if (msg.content && msg.role !== 'tool') {
      contentBlocks.push({
        text: msg.content
      } as any);
    }

    // Add tool calls as toolUse blocks
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      for (const toolCall of msg.toolCalls) {
        contentBlocks.push({
          toolUse: {
            // Use the existing toolCallId if available (from Bedrock response),
            // otherwise generate a temporary one
            toolUseId: toolCall.id || `${toolCall.function.name}-${Date.now()}`,
            name: toolCall.function.name,
            input: toolCall.function.arguments
          }
        } as any);
      }
    }

    // Add images if present
    if (msg.images && msg.images.length > 0) {
      for (const image of msg.images) {
        if (typeof image === 'string') {
          // Base64 string
          if (image.startsWith('data:')) {
            const [header, data] = image.split(',');
            const mediaType = header.match(/:(.*?);/)?.[1] || 'image/png';
            contentBlocks.push({
              image: {
                format: (mediaType.split('/')[1] || 'png') as any,
                source: {
                  bytes: Buffer.from(data, 'base64')
                }
              }
            } as any);
          }
        } else {
          // Uint8Array
          contentBlocks.push({
            image: {
              format: 'png' as any,
              source: {
                bytes: image
              }
            }
          } as any);
        }
      }
    }

    // Handle tool results
    if (msg.role === 'tool') {
      contentBlocks.push({
        toolResult: {
          toolUseId: msg.toolCallId || 'tool-result', // Use the original toolUseId if available
          content: [{ text: msg.content }],
          status: 'success'
        }
      } as any);
    }

    return {
      role: msg.role === 'tool' ? 'user' : (msg.role as any),
      content: contentBlocks
    };
  }

  /**
   * Translate Bedrock Message to ChatMessage
   */
  private bedrockMessageToChatMessage(msg: any): ChatMessage {
    let content = '';
    const toolCalls: ChatToolCall[] = [];

    if (msg.content && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        // Skip undefined or null blocks
        if (!block) {
          continue;
        }

        if (block.text) {
          content += block.text;
        }

        if (block.toolUse) {
          toolCalls.push({
            id: block.toolUse.toolUseId, // Store toolUseId for later reference
            function: {
              name: block.toolUse.name,
              arguments: block.toolUse.input || {}
            }
          });
        }
      }
    }

    const chatMsg: ChatMessage = {
      role: 'assistant',
      content
    };

    if (toolCalls.length > 0) {
      chatMsg.toolCalls = toolCalls;
    }

    return chatMsg;
  }

  /**
   * Translate ChatTool to Bedrock ToolSpecification
   */
  private chatToolToBedrockTool(chatTool: ChatTool): any {
    // Bedrock expects the JSON schema directly in the inputSchema.json field
    // Strip out descriptions from properties as Bedrock may not support them
    const schema = chatTool.function.parameters || { type: 'object', properties: {} };

    // Clean the schema by removing descriptions from properties
    const cleanedSchema = this.cleanSchema(schema);

    return {
      toolSpec: {
        name: chatTool.function.name,
        description: chatTool.function.description,
        inputSchema: {
          json: cleanedSchema
        }
      }
    };
  }

  /**
   * Clean JSON schema by removing unsupported fields like descriptions from properties
   */
  private cleanSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    const cleaned = { ...schema };

    // If this schema has properties, clean each property
    if (cleaned.properties && typeof cleaned.properties === 'object') {
      cleaned.properties = { ...cleaned.properties };
      for (const [key, value] of Object.entries(cleaned.properties)) {
        if (value && typeof value === 'object') {
          const cleanedProp: any = {};
          // Only copy type and enum fields, skip description
          if ((value as any).type) cleanedProp.type = (value as any).type;
          if ((value as any).enum) cleanedProp.enum = (value as any).enum;
          if ((value as any).items) cleanedProp.items = this.cleanSchema((value as any).items);
          if ((value as any).properties) cleanedProp.properties = this.cleanSchema((value as any).properties);
          cleaned.properties[key] = cleanedProp;
        }
      }
    }

    return cleaned;
  }

  /**
   * Map Bedrock stop reason to provider-agnostic format
   */
  private mapStopReason(
    bedrockStopReason: string | undefined
  ): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
    switch (bedrockStopReason) {
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
        return 'stop_sequence';
      default:
        return 'end_turn';
    }
  }

  /**
   * Translate errors to ProviderError types
   */
  private translateError(error: any): ProviderError {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = (error as any).name || '';

    // Authentication/authorization errors
    if (
      errorName.includes('ValidationException') ||
      errorMessage.includes('Invalid') ||
      errorMessage.includes('credentials')
    ) {
      return new ProviderAuthenticationError(
        `Bedrock authentication failed: ${errorMessage}`,
        error instanceof Error ? error : undefined
      );
    }

    // Model not found
    if (
      errorName.includes('ResourceNotFoundException') ||
      errorMessage.includes('model not found')
    ) {
      return new ProviderModelNotFoundError(
        this.model,
        `Model ${this.model} not found in Bedrock: ${errorMessage}`,
        error instanceof Error ? error : undefined
      );
    }

    // Rate limiting
    if (
      errorName.includes('ThrottlingException') ||
      errorMessage.includes('rate limit') ||
      errorMessage.includes('throttl')
    ) {
      return new ProviderRateLimitError(
        `Bedrock rate limited: ${errorMessage}`,
        undefined,
        error instanceof Error ? error : undefined
      );
    }

    // Service errors
    if (
      errorName.includes('ServiceUnavailableException') ||
      errorName.includes('InternalServerException')
    ) {
      return new ProviderError(
        `Bedrock service error: ${errorMessage}`,
        error instanceof Error ? error : undefined
      );
    }

    // Generic error
    return new ProviderError(errorMessage, error instanceof Error ? error : undefined);
  }
}
