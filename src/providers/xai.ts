import { LLMProvider, ProviderCapabilities } from "./interface.js";
import {
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  ChatTool,
  ProviderError,
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderModelNotFoundError,
  ProviderContextLengthError,
} from "./types.js";
import {
  accumulateOpenAIStreamToolCall,
  buildOpenAIChatCompletionRequestBody,
  buildOpenAIStreamToolCalls,
  applyOpenAIMessageCore,
  createOpenAIToolDefinition,
  isAbortOrTransportError,
  isContextLengthError,
  parseJsonMaybe,
  normalizeErrorMessage,
  parseOpenAIStreamToolCallArguments,
  parseRetryAfterSeconds,
  readSseDataLines,
} from "./shared.js";

const XAI_API_URLS = [
  "https://api.x.ai/v1/chat/completions",
  "https://us-east-1.api.x.ai/v1/chat/completions",
  "https://eu-west-1.api.x.ai/v1/chat/completions",
] as const;

/** OpenAI-compatible message format for API request */
interface OpenAIMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** OpenAI-compatible tool format */
interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

/**
 * xAI (Grok) implementation of LLMProvider using the OpenAI-compatible API at api.x.ai.
 */
export class XaiProvider implements LLMProvider {
  readonly name = "xai";
  private readonly model: string;
  private readonly apiKey: string;

  private static readonly CONTEXT_WINDOWS: Record<string, number> = {
    "grok-4.20-0309-reasoning": 2_000_000,
    "grok-4.20-0309-non-reasoning": 2_000_000,
    "grok-4.20-multi-agent-0309": 2_000_000,
    "grok-4-1-fast-reasoning": 2_000_000,
    "grok-4-1-fast-non-reasoning": 2_000_000,
  };

  private static readonly DEFAULT_CONTEXT_WINDOW = 2_000_000;

  constructor(options: { model: string; apiKey?: string }) {
    const apiKey = options.apiKey ?? process.env.XAI_API_KEY ?? "";
    if (!apiKey || apiKey.trim() === "") {
      throw new ProviderAuthenticationError(
        "xAI API key is required. Set XAI_API_KEY or pass apiKey in options.",
      );
    }
    this.model = options.model;
    this.apiKey = apiKey;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      contextWindowTokens:
        XaiProvider.CONTEXT_WINDOWS[this.model] ??
        XaiProvider.DEFAULT_CONTEXT_WINDOW,
    };
  }

  private chatMessageToOpenAIMessage(msg: ChatMessage): OpenAIMessage {
    const role = msg.role as OpenAIMessage["role"];
    const out: OpenAIMessage = { role, content: msg.content ?? "" };
    return applyOpenAIMessageCore(out, msg);
  }

  private chatToolToOpenAITool(tool: ChatTool): OpenAITool {
    return createOpenAIToolDefinition(tool);
  }

  private shouldRetryEndpoint(status?: number): boolean {
    return status !== undefined && status >= 500 && status < 600;
  }

  private async createChatCompletionResponse(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: ProviderError | null = null;

    for (const apiUrl of XAI_API_URLS) {
      try {
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });

        if (response.ok) {
          return response;
        }

        let errorBody = "";
        try {
          errorBody = await response.text();
        } catch {
          // ignore read failures
        }

        const translated = this.translateError(
          new Error(errorBody || `HTTP ${response.status}`),
          response,
        );

        if (this.shouldRetryEndpoint(response.status)) {
          lastError = translated;
          continue;
        }

        throw translated;
      } catch (error) {
        if (error instanceof ProviderError) {
          throw error;
        }

        const translated = this.translateError(error);
        const isAbort =
          translated.message === "Request cancelled" ||
          translated.originalError?.name === "AbortError";
        if (!isAbort) {
          lastError = translated;
          continue;
        }

        throw translated;
      }
    }

    throw lastError ?? new ProviderError("xAI request failed");
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    try {
      const body = this.createChatCompletionRequestBody(request);
      const response = await this.createChatCompletionResponse(
        body,
        request.signal,
      );

      const reader = this.getResponseReader(response);
      if (!reader) {
        throw this.translateError(new Error("No response body"));
      }
      const toolCallsByIndex = new Map<number, AccumulatedToolCall>();
      yield* this.consumeStream(reader, toolCallsByIndex);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw this.translateError(error);
    }
  }

  private createChatCompletionRequestBody(
    request: ChatRequest,
  ): Record<string, unknown> {
    return buildOpenAIChatCompletionRequestBody({
      request,
      model: this.model,
      mapMessage: (msg) => this.chatMessageToOpenAIMessage(msg),
      mapTool: (tool) => this.chatToolToOpenAITool(tool),
    });
  }

  private getResponseReader(
    response: Response,
  ): ReadableStreamDefaultReader<Uint8Array> | null {
    return response.body?.getReader() ?? null;
  }

  private async *consumeStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    toolCallsByIndex: Map<number, AccumulatedToolCall>,
  ): AsyncIterable<ChatStreamEvent> {
    for await (const data of readSseDataLines(reader)) {
      const events = this.parseStreamLine(data, toolCallsByIndex);
      for (const event of events) {
        yield event;
      }
    }
  }

  private parseStreamLine(
    data: string,
    toolCallsByIndex: Map<number, AccumulatedToolCall>,
  ): ChatStreamEvent[] {
    if (data === "[DONE]") {
      return [];
    }

    const chunk = parseJsonMaybe<{
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string;
      }>;
    }>(data);
    const choice = chunk?.choices?.[0];
    if (!choice?.delta) {
      return [];
    }

    const events: ChatStreamEvent[] = [];
    const delta = choice.delta;

    if (delta.content != null && delta.content !== "") {
      events.push({ type: "assistant_text", delta: delta.content });
    }

    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        accumulateOpenAIStreamToolCall(tc, toolCallsByIndex, () => ({
          name: "",
          argsString: "",
        }));
      }
    }

    if (choice.finish_reason === "tool_calls") {
      const toolCalls = buildOpenAIStreamToolCalls(toolCallsByIndex, (acc) => ({
        id: acc.id,
        function: {
          name: acc.name || "",
          arguments: parseOpenAIStreamToolCallArguments(acc.argsString),
        },
      }));
      if (toolCalls.length > 0) {
        events.push({ type: "tool_calls", toolCalls });
      }
    }

    return events;
  }

  private isContextLengthError(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.includes("context length") ||
      lower.includes("context window") ||
      lower.includes("maximum context") ||
      lower.includes("token limit") ||
      lower.includes("too many tokens") ||
      lower.includes("input is too long") ||
      lower.includes("prompt is too long") ||
      lower.includes("exceeds the model") ||
      lower.includes("reduce your prompt")
    );
  }

  private translateError(error: unknown, response?: Response): ProviderError {
    const originalError =
      error instanceof Error ? error : new Error(String(error));
    const normalizedMessage = normalizeErrorMessage(originalError.message);

    if (response) {
      const translatedResponseError = this.translateResponseError(
        response,
        normalizedMessage,
        originalError,
      );
      if (translatedResponseError) {
        return translatedResponseError;
      }
    }

    const msg = normalizedMessage || originalError.message;
    return this.translateMessageError(msg, originalError);
  }

  private translateResponseError(
    response: Response,
    normalizedMessage: string,
    originalError: Error,
  ): ProviderError | null {
    if (response.status === 400 && isContextLengthError(normalizedMessage)) {
      return new ProviderContextLengthError(
        `Context length exceeded: ${normalizedMessage}`,
        originalError,
      );
    }
    if (response.status === 401) {
      return new ProviderAuthenticationError(
        "Invalid xAI API key",
        originalError,
      );
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterSeconds = parseRetryAfterSeconds(retryAfter);
      return new ProviderRateLimitError(
        "xAI rate limit exceeded",
        retryAfterSeconds,
        originalError,
      );
    }
    if (response.status === 404) {
      return new ProviderModelNotFoundError(
        this.model,
        `Model not found: ${this.model}`,
        originalError,
      );
    }
    if (response.status >= 500 && response.status < 600) {
      return new ProviderError(
        normalizedMessage
          ? `xAI service error: ${normalizedMessage}`
          : "xAI service error",
        originalError,
      );
    }

    return null;
  }

  private translateMessageError(
    msg: string,
    originalError: Error,
  ): ProviderError {
    if (isContextLengthError(msg)) {
      return new ProviderContextLengthError(
        `Context length exceeded: ${msg}`,
        originalError,
      );
    }

    if (msg && (msg.includes("AbortError") || msg.includes("aborted"))) {
      return new ProviderError("Request cancelled", originalError);
    }
    if (msg && isAbortOrTransportError(msg)) {
      return new ProviderError("Failed to connect to xAI API", originalError);
    }
    return new ProviderError(
      originalError.message || "xAI request failed",
      originalError,
    );
  }
}

interface AccumulatedToolCall {
  id?: string;
  name: string;
  argsString: string;
}
