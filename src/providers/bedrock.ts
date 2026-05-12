import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { LLMProvider, ProviderCapabilities } from "./interface.js";
import {
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  ChatTool,
  ChatToolCall,
  ProviderError,
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderModelNotFoundError,
  ProviderContextLengthError,
  ProviderCapacityError,
} from "./types.js";
import { withRetry } from "./withRetry.js";
import type { AgentDiagnosticEvent } from "../diagnostics.js";

/**
 * Bedrock implementation of LLMProvider
 */
export class BedrockProvider implements LLMProvider {
  readonly name = "bedrock";
  private client: BedrockRuntimeClient;
  private model: string;
  private retryConfig?: { maxRetries: number; consecutive529Limit: number };
  private onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;

  private static readonly CONTEXT_WINDOWS: Record<string, number> = {
    "anthropic.claude-sonnet-4-20250514-v1:0": 200000,
    "anthropic.claude-3-5-sonnet-20241022-v2:0": 200000,
    "anthropic.claude-3-5-haiku-20241022-v1:0": 200000,
    "anthropic.claude-3-opus-20240229-v1:0": 200000,
    "anthropic.claude-3-haiku-20240307-v1:0": 200000,
    "amazon.nova-pro-v1:0": 300000,
    "amazon.nova-lite-v1:0": 300000,
  };

  private static readonly DEFAULT_CONTEXT_WINDOW = 200000;

  constructor(options: {
    model: string;
    region?: string;
    retryConfig?: { maxRetries: number; consecutive529Limit: number };
    onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;
  }) {
    const region = options.region || "us-east-1";
    this.client = new BedrockRuntimeClient({ region });
    this.model = options.model;
    this.retryConfig = options.retryConfig;
    this.onDiagnosticEvent = options.onDiagnosticEvent;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      contextWindowTokens:
        BedrockProvider.CONTEXT_WINDOWS[this.model] ??
        BedrockProvider.DEFAULT_CONTEXT_WINDOW,
    };
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    try {
      const command = this.createConverseStreamCommand(request);
      const response = await withRetry(
        () => this.client.send(command, { abortSignal: request.signal }),
        {
          maxRetries: this.retryConfig?.maxRetries ?? 3,
          baseDelayMs: 500,
          isRetryable: (err) => {
            const name = (err as any)?.name ?? "";
            const msg = err instanceof Error ? err.message : String(err);
            return (
              name === "ThrottlingException" ||
              name === "ServiceUnavailableException" ||
              name === "InternalServerException" ||
              msg.includes("rate limit") ||
              msg.includes("throttl")
            );
          },
          consecutive529Limit: this.retryConfig?.consecutive529Limit ?? 3,
          onRetry: (ctx) =>
            this.onDiagnosticEvent?.({
              type: "provider_retry",
              provider: this.name,
              model: request.model || this.model,
              iteration: request.iteration ?? 0,
              reason:
                ctx.err instanceof Error ? ctx.err.message : String(ctx.err),
              attemptNumber: ctx.attempt + 1,
              delayMs: ctx.delayMs,
            }),
        },
      );
      const stream = this.getStreamFromResponse(response);

      if (!stream) {
        throw new Error("No stream output");
      }

      const state = {
        toolCalls: [] as ChatToolCall[],
        currentToolCall: null as Partial<ChatToolCall> | null,
        currentToolInput: "",
        stopReason: "end_turn" as any,
      };

      for await (const event of stream as AsyncIterable<any>) {
        // Capture stop reason from messageStop event
        if (event.messageStop?.stopReason) {
          const bedrockReason = event.messageStop.stopReason;
          // Map Bedrock stop_reason to normalized StopReason
          if (bedrockReason === "stop_sequence") {
            state.stopReason = "stop_sequence";
          } else if (bedrockReason === "max_tokens") {
            state.stopReason = "max_tokens";
          } else if (bedrockReason === "tool_use") {
            state.stopReason = "tool_use";
          } else {
            state.stopReason = "end_turn";
          }
        }

        const assistantText = this.handleStreamEvent(event, state);
        if (assistantText) {
          yield { type: "assistant_text", delta: assistantText };
        }
      }

      if (state.toolCalls.length > 0) {
        yield { type: "tool_calls", toolCalls: state.toolCalls };
      }

      // Emit normalized terminal event (Phase 4.5)
      yield { type: "terminal", stopReason: state.stopReason };
    } catch (error) {
      throw this.translateError(error);
    }
  }

  private createConverseStreamCommand(
    request: ChatRequest,
  ): ConverseStreamCommand {
    const systemMessage = request.messages.find((m) => m.role === "system");
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((msg) => this.chatMessageToBedrockMessage(msg));
    const toolConfig = request.tools
      ? {
          tools: request.tools.map((tool) => this.chatToolToBedrockTool(tool)),
        }
      : undefined;

    return new ConverseStreamCommand({
      modelId: request.model || this.model,
      messages: messages as any,
      system: systemMessage ? [{ text: systemMessage.content }] : undefined,
      toolConfig: toolConfig as any,
    });
  }

  private getStreamFromResponse(
    response: unknown,
  ): AsyncIterable<any> | undefined {
    let stream = (response as any).stream || (response as any).output;

    if (
      !stream &&
      typeof response === "object" &&
      response !== null &&
      Symbol.asyncIterator in response
    ) {
      stream = response;
    }

    return stream as AsyncIterable<any> | undefined;
  }

  private handleStreamEvent(
    event: any,
    state: {
      toolCalls: ChatToolCall[];
      currentToolCall: Partial<ChatToolCall> | null;
      currentToolInput: string;
    },
  ): string | undefined {
    let assistantText: string | undefined;

    if (event.contentBlockDelta) {
      assistantText = this.handleContentBlockDelta(
        event.contentBlockDelta.delta,
        state,
      );
    }

    if (event.contentBlockStart) {
      this.handleContentBlockStart(event.contentBlockStart.start, state);
    }

    if (event.contentBlockStop) {
      this.handleContentBlockStop(state);
    }

    return assistantText;
  }

  private handleContentBlockDelta(
    delta: any,
    state: {
      toolCalls: ChatToolCall[];
      currentToolCall: Partial<ChatToolCall> | null;
      currentToolInput: string;
    },
  ): string | undefined {
    if (delta.text) {
      return delta.text;
    }

    if (delta.toolUse) {
      const partialInput = delta.toolUse.input;
      if (partialInput) {
        state.currentToolInput += partialInput;
      }
    }

    return undefined;
  }

  private handleContentBlockStart(
    start: any,
    state: {
      toolCalls: ChatToolCall[];
      currentToolCall: Partial<ChatToolCall> | null;
      currentToolInput: string;
    },
  ): void {
    const toolUse = start?.toolUse;
    if (!toolUse) {
      return;
    }

    state.currentToolCall = {
      id: toolUse.toolUseId,
      function: {
        name: toolUse.name,
        arguments: {},
      },
    };
    state.currentToolInput = "";
  }

  private handleContentBlockStop(state: {
    toolCalls: ChatToolCall[];
    currentToolCall: Partial<ChatToolCall> | null;
    currentToolInput: string;
  }): void {
    if (!state.currentToolCall?.function || !state.currentToolInput) {
      return;
    }

    try {
      state.currentToolCall.function.arguments = JSON.parse(
        state.currentToolInput,
      );
    } catch {
      state.currentToolCall.function.arguments = {
        raw: state.currentToolInput,
      };
    }

    state.toolCalls.push(state.currentToolCall as ChatToolCall);
    state.currentToolCall = null;
    state.currentToolInput = "";
  }

  /**
   * Check if a message is a system message
   */
  private isSystemMessage(msg: ChatMessage): boolean {
    return msg.role === "system";
  }

  /**
   * Translate ChatMessage to Bedrock Message format
   */
  private chatMessageToBedrockMessage(msg: ChatMessage): any {
    const contentBlocks: any[] = [];

    this.appendTextContentBlock(msg, contentBlocks);
    this.appendToolCallBlocks(msg, contentBlocks);
    this.appendImageBlocks(msg, contentBlocks);
    this.appendToolResultBlocks(msg, contentBlocks);

    return {
      role: msg.role === "tool" ? "user" : (msg.role as any),
      content: contentBlocks,
    };
  }

  private appendTextContentBlock(msg: ChatMessage, contentBlocks: any[]): void {
    if (msg.content && msg.role !== "tool") {
      contentBlocks.push({
        text: msg.content,
      } as any);
    }
  }

  private appendToolCallBlocks(msg: ChatMessage, contentBlocks: any[]): void {
    if (!msg.toolCalls || msg.toolCalls.length === 0) {
      return;
    }

    for (const toolCall of msg.toolCalls) {
      contentBlocks.push({
        toolUse: {
          toolUseId: toolCall.id || `${toolCall.function.name}-${Date.now()}`,
          name: toolCall.function.name,
          input: toolCall.function.arguments,
        },
      } as any);
    }
  }

  private appendImageBlocks(msg: ChatMessage, contentBlocks: any[]): void {
    if (!msg.images || msg.images.length === 0) {
      return;
    }

    for (const image of msg.images) {
      if (typeof image === "string") {
        this.appendBase64ImageBlock(image, contentBlocks);
      } else {
        contentBlocks.push({
          image: {
            format: "png" as any,
            source: {
              bytes: image,
            },
          },
        } as any);
      }
    }
  }

  private appendBase64ImageBlock(image: string, contentBlocks: any[]): void {
    if (!image.startsWith("data:")) {
      return;
    }

    const [header, data] = image.split(",");
    const mediaType = header.match(/:(.*?);/)?.[1] || "image/png";
    contentBlocks.push({
      image: {
        format: (mediaType.split("/")[1] || "png") as any,
        source: {
          bytes: Buffer.from(data, "base64"),
        },
      },
    } as any);
  }

  private appendToolResultBlocks(msg: ChatMessage, contentBlocks: any[]): void {
    if (msg.role !== "tool") {
      return;
    }

    if (msg.toolResults && msg.toolResults.length > 0) {
      for (const toolResult of msg.toolResults) {
        contentBlocks.push({
          toolResult: {
            toolUseId: toolResult.toolCallId,
            content: [{ text: toolResult.content }],
            status: "success",
          },
        } as any);
      }
      return;
    }

    if (msg.toolCallId) {
      contentBlocks.push({
        toolResult: {
          toolUseId: msg.toolCallId,
          content: [{ text: msg.content }],
          status: "success",
        },
      } as any);
    }
  }

  /**
   * Translate Bedrock Message to ChatMessage
   */
  private bedrockMessageToChatMessage(msg: any): ChatMessage {
    let content = "";
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
              arguments: block.toolUse.input || {},
            },
          });
        }
      }
    }

    const chatMsg: ChatMessage = {
      role: "assistant",
      content,
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
    const schema = chatTool.function.parameters || {
      type: "object",
      properties: {},
    };

    // Clean the schema by removing descriptions from properties
    const cleanedSchema = this.cleanSchema(schema);

    return {
      toolSpec: {
        name: chatTool.function.name,
        description: chatTool.function.description,
        inputSchema: {
          json: cleanedSchema,
        },
      },
    };
  }

  /**
   * Clean JSON schema by removing unsupported fields like descriptions from properties
   */
  private cleanSchema(schema: any): any {
    if (!schema || typeof schema !== "object") {
      return schema;
    }

    const cleaned = { ...schema };

    // If this schema has properties, clean each property
    if (cleaned.properties && typeof cleaned.properties === "object") {
      cleaned.properties = { ...cleaned.properties };
      for (const [key, value] of Object.entries(cleaned.properties)) {
        if (value && typeof value === "object") {
          const cleanedProp: any = {};
          // Only copy type and enum fields, skip description
          if ((value as any).type) cleanedProp.type = (value as any).type;
          if ((value as any).enum) cleanedProp.enum = (value as any).enum;
          if ((value as any).items)
            cleanedProp.items = this.cleanSchema((value as any).items);
          if ((value as any).properties)
            cleanedProp.properties = this.cleanSchema(
              (value as any).properties,
            );
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
    bedrockStopReason: string | undefined,
  ): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
    switch (bedrockStopReason) {
      case "tool_use":
        return "tool_use";
      case "max_tokens":
        return "max_tokens";
      case "stop_sequence":
        return "stop_sequence";
      default:
        return "end_turn";
    }
  }

  /**
   * Translate errors to ProviderError types
   */
  private isContextLengthError(message: string, name: string): boolean {
    const lower = message.toLowerCase();
    return (
      name.includes("ModelInputLimitExceededException") ||
      lower.includes("too many input tokens") ||
      lower.includes("context length") ||
      lower.includes("input is too long") ||
      lower.includes("prompt is too long") ||
      lower.includes("maximum number of tokens") ||
      lower.includes("exceeds the model")
    );
  }

  private translateError(error: any): ProviderError {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = (error as any).name || "";

    if (this.isContextLengthError(errorMessage, errorName)) {
      return new ProviderContextLengthError(
        `Context length exceeded: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }

    // Authentication/authorization errors
    if (
      errorName.includes("ValidationException") ||
      errorMessage.includes("Invalid") ||
      errorMessage.includes("credentials")
    ) {
      return new ProviderAuthenticationError(
        `Bedrock authentication failed: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }

    // Model not found
    if (
      errorName.includes("ResourceNotFoundException") ||
      errorMessage.includes("model not found")
    ) {
      return new ProviderModelNotFoundError(
        this.model,
        `Model ${this.model} not found in Bedrock: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }

    // Rate limiting
    if (
      errorName.includes("ThrottlingException") ||
      errorMessage.includes("rate limit") ||
      errorMessage.includes("throttl")
    ) {
      return new ProviderRateLimitError(
        `Bedrock rate limited: ${errorMessage}`,
        undefined,
        error instanceof Error ? error : undefined,
      );
    }

    // Service errors
    if (
      errorName.includes("ServiceUnavailableException") ||
      errorName.includes("InternalServerException")
    ) {
      return new ProviderError(
        `Bedrock service error: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }

    // Generic error
    return new ProviderError(
      errorMessage,
      error instanceof Error ? error : undefined,
    );
  }
}
