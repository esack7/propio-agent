import Anthropic from "@anthropic-ai/sdk";
import { LLMProvider, ProviderCapabilities } from "./interface.js";
import { createProviderCapabilities } from "./capabilities.js";
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
} from "./types.js";
import { withRetry } from "./withRetry.js";
import type { AgentDiagnosticEvent } from "../diagnostics.js";

interface AnthropicStreamState {
  toolCalls: ChatToolCall[];
  currentToolCall: Partial<ChatToolCall> | null;
  currentToolInputJson: string;
  thinkingContent: string;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;
  private capabilities: ProviderCapabilities;
  private retryConfig?: { maxRetries: number; consecutive529Limit: number };
  private onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;

  constructor(options: {
    model: string;
    contextWindowTokens: number;
    apiKey?: string;
    retryConfig?: { maxRetries: number; consecutive529Limit: number };
    onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;
  }) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ProviderAuthenticationError(
        "Anthropic API key not found. Set ANTHROPIC_API_KEY environment variable or provide apiKey in config.",
      );
    }

    this.client = new Anthropic({ apiKey });
    this.retryConfig = options.retryConfig;
    this.onDiagnosticEvent = options.onDiagnosticEvent;
    this.capabilities = createProviderCapabilities(options.contextWindowTokens);
    this.model = options.model;
  }

  getCapabilities(): ProviderCapabilities {
    return this.capabilities;
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    try {
      const systemMessage = request.messages.find((m) => m.role === "system");
      const messages = request.messages
        .filter((m) => m.role !== "system")
        .map((msg) => this.chatMessageToAnthropicMessage(msg));

      const anthropicTools = request.tools?.map((tool) =>
        this.chatToolToAnthropicTool(tool),
      );

      const thinkingBudget = request.requestReasoning ? 10000 : undefined;
      const maxTokens = thinkingBudget ? Math.max(thinkingBudget + 1000, 16000) : 4096;

      const createStream = () =>
        Promise.resolve(
          this.client.messages.stream({
            model: request.model || this.model,
            max_tokens: maxTokens,
            system: systemMessage?.content,
            messages: messages as Anthropic.MessageParam[],
            tools: anthropicTools as Anthropic.Tool[] | undefined,
            thinking: thinkingBudget
              ? { type: "enabled", budget_tokens: thinkingBudget }
              : undefined,
          }),
        );

      const stream = await withRetry(
        createStream,
        this.createRetryOptions(request),
      ) as AsyncIterable<Anthropic.MessageStreamEvent>;

      const state: AnthropicStreamState = {
        toolCalls: [],
        currentToolCall: null,
        currentToolInputJson: "",
        thinkingContent: "",
        stopReason: "end_turn",
      };

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          this.handleContentBlockStart(event as Anthropic.RawContentBlockStartEvent, state);
        } else if (event.type === "content_block_delta") {
          this.handleContentBlockDelta(event as Anthropic.RawContentBlockDeltaEvent, state, request);
        } else if (event.type === "content_block_stop") {
          this.handleContentBlockStop(state);
        } else if (event.type === "message_stop") {
          const stopEvent = event as Anthropic.RawMessageStopEvent;
          if ((stopEvent as any).message?.stop_reason) {
            state.stopReason = this.mapStopReason((stopEvent as any).message.stop_reason);
          }
        }
      }

      if (state.thinkingContent) {
        yield { type: "thinking_delta", delta: state.thinkingContent };
      }

      if (state.toolCalls.length > 0) {
        yield { type: "tool_calls", toolCalls: state.toolCalls };
      }

      yield { type: "terminal", stopReason: state.stopReason };
    } catch (error) {
      throw this.translateError(error);
    }
  }

  private handleContentBlockStart(
    event: Anthropic.RawContentBlockStartEvent,
    state: AnthropicStreamState,
  ): void {
    const block = event.content_block;
    if (block.type === "tool_use") {
      const toolBlock = block as Anthropic.ToolUseBlock;
      state.currentToolCall = {
        id: toolBlock.id,
        function: {
          name: toolBlock.name,
          arguments: {},
        },
      };
      state.currentToolInputJson = "";
    }
  }

  private handleContentBlockDelta(
    event: Anthropic.RawContentBlockDeltaEvent,
    state: AnthropicStreamState,
    request: ChatRequest,
  ): void {
    const delta = event.delta;

    if (delta.type === "text_delta") {
      const textDelta = delta as Anthropic.TextDelta;
      if (textDelta.text) {
        // We yield here in the actual loop
        // This is handled by accumulating in the loop
      }
    } else if (delta.type === "thinking_delta") {
      const thinkingDelta = delta as Anthropic.ThinkingDelta;
      state.thinkingContent += thinkingDelta.thinking || "";
    } else if (delta.type === "input_json_delta") {
      const jsonDelta = delta as Anthropic.InputJSONDelta;
      state.currentToolInputJson += jsonDelta.partial_json || "";
    }
  }

  private handleContentBlockStop(state: AnthropicStreamState): void {
    if (
      !state.currentToolCall?.function ||
      !state.currentToolInputJson
    ) {
      return;
    }

    try {
      state.currentToolCall.function.arguments = JSON.parse(
        state.currentToolInputJson,
      );
    } catch {
      state.currentToolCall.function.arguments = {
        raw: state.currentToolInputJson,
      };
    }

    state.toolCalls.push(state.currentToolCall as ChatToolCall);
    state.currentToolCall = null;
    state.currentToolInputJson = "";
  }

  private mapStopReason(
    reason: string,
  ): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
    switch (reason) {
      case "end_turn":
        return "end_turn";
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

  private chatMessageToAnthropicMessage(msg: ChatMessage): Anthropic.MessageParam {
    const content: Anthropic.ContentBlockParam[] = [];

    // Add text content
    if (msg.content && msg.role !== "tool") {
      content.push({
        type: "text",
        text: msg.content,
      });
    }

    // Add tool calls (when replaying an assistant message with tool calls)
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      for (const toolCall of msg.toolCalls) {
        content.push({
          type: "tool_use",
          id: toolCall.id || `${toolCall.function.name}-${Date.now()}`,
          name: toolCall.function.name,
          input: toolCall.function.arguments,
        });
      }
    }

    // Add images
    if (msg.images && msg.images.length > 0) {
      for (const image of msg.images) {
        const imageData = typeof image === "string" ? image : Buffer.from(image).toString("base64");
        const mediaType = this.extractMediaType(imageData);

        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType as any,
            data: imageData.includes(",")
              ? imageData.split(",")[1]
              : imageData,
          },
        });
      }
    }

    // Add tool results for tool role messages
    if (msg.role === "tool") {
      if (msg.toolResults && msg.toolResults.length > 0) {
        for (const toolResult of msg.toolResults) {
          content.push({
            type: "tool_result",
            tool_use_id: toolResult.toolCallId,
            content: toolResult.content,
          });
        }
      } else if (msg.toolCallId) {
        content.push({
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: msg.content,
        });
      }
    }

    return {
      role: msg.role === "tool" ? "user" : (msg.role as any),
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
    };
  }

  private extractMediaType(
    image: string,
  ): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
    if (image.startsWith("data:")) {
      const match = image.match(/:(.*?);/);
      if (match && match[1]) {
        const type = match[1];
        if (
          type === "image/jpeg" ||
          type === "image/png" ||
          type === "image/gif" ||
          type === "image/webp"
        ) {
          return type;
        }
      }
    }
    return "image/png";
  }

  private chatToolToAnthropicTool(chatTool: ChatTool): Anthropic.Tool {
    return {
      name: chatTool.function.name,
      description: chatTool.function.description,
      input_schema: chatTool.function.parameters as Anthropic.Tool["input_schema"],
    };
  }

  private createRetryOptions(request: ChatRequest) {
    return {
      maxRetries: this.retryConfig?.maxRetries ?? 3,
      baseDelayMs: 500,
      isRetryable: (error: unknown) => this.isRetryableError(error),
      consecutive529Limit: this.retryConfig?.consecutive529Limit ?? 3,
      onRetry: (ctx: {
        err: unknown;
        attempt: number;
        delayMs: number;
      }): void => this.emitRetryDiagnostic(request, ctx),
    };
  }

  private isRetryableError(error: unknown): boolean {
    const isAnthropicError = error instanceof Anthropic.APIError;

    if (isAnthropicError) {
      const status = error.status;
      return (
        status === 429 || // rate limit
        status === 500 || // internal server error
        status === 502 || // bad gateway
        status === 503 || // service unavailable
        status === 504 // gateway timeout
      );
    }

    const name = (error as any)?.name ?? "";
    const message = error instanceof Error ? error.message : String(error);
    return (
      name.includes("timeout") ||
      message.includes("rate limit") ||
      message.includes("throttle") ||
      message.includes("ECONNREFUSED") ||
      message.includes("ENOTFOUND")
    );
  }

  private emitRetryDiagnostic(
    request: ChatRequest,
    ctx: { err: unknown; attempt: number; delayMs: number },
  ): void {
    this.onDiagnosticEvent?.({
      type: "provider_retry",
      provider: this.name,
      model: request.model || this.model,
      iteration: request.iteration ?? 0,
      reason: ctx.err instanceof Error ? ctx.err.message : String(ctx.err),
      attemptNumber: ctx.attempt + 1,
      delayMs: ctx.delayMs,
    });
  }

  private translateError(error: unknown): Error {
    // Handle Anthropic SDK errors
    if (error instanceof Anthropic.APIError) {
      const status = error.status;

      if (status === 401 || error.message.includes("authentication")) {
        return new ProviderAuthenticationError(
          `Anthropic authentication failed: ${error.message}`,
          error,
        );
      }

      if (status === 429) {
        const retryAfter = error.headers?.["retry-after"];
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter) : undefined;
        return new ProviderRateLimitError(
          `Anthropic rate limit exceeded: ${error.message}`,
          retryAfterSeconds,
          error,
        );
      }

      if (status === 404 || error.message.includes("Model not found")) {
        return new ProviderModelNotFoundError(
          this.model,
          `Anthropic model not found: ${error.message}`,
          error,
        );
      }

      if (
        status === 400 &&
        error.message.includes("context length")
      ) {
        return new ProviderContextLengthError(
          `Anthropic context length exceeded: ${error.message}`,
          error,
        );
      }

      return new ProviderError(
        `Anthropic API error: ${error.message}`,
        error,
      );
    }

    if (error instanceof Error) {
      return new ProviderError(`Anthropic provider error: ${error.message}`, error);
    }

    return new ProviderError(
      `Anthropic provider error: ${String(error)}`,
    );
  }
}
