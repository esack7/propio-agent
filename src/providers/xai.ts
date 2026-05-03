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
} from "./types.js";

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

  private expandToolResults(messages: ChatMessage[]): ChatMessage[] {
    const expanded: ChatMessage[] = [];
    for (const msg of messages) {
      if (
        msg.role === "tool" &&
        msg.toolResults &&
        msg.toolResults.length > 0
      ) {
        for (const toolResult of msg.toolResults) {
          expanded.push({
            role: "tool",
            content: toolResult.content,
            toolCallId: toolResult.toolCallId,
          });
        }
      } else {
        expanded.push(msg);
      }
    }
    return expanded;
  }

  private chatMessageToOpenAIMessage(msg: ChatMessage): OpenAIMessage {
    const role = msg.role as OpenAIMessage["role"];
    const out: OpenAIMessage = { role, content: msg.content ?? "" };
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      out.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id ?? `call_${tc.function.name}_${Date.now()}`,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments:
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {}),
        },
      }));
    }
    if (msg.role === "tool" && msg.toolCallId) {
      out.tool_call_id = msg.toolCallId;
    }
    return out;
  }

  private chatToolToOpenAITool(tool: ChatTool): OpenAITool {
    return {
      type: "function",
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: (tool.function.parameters ?? {
          type: "object",
          properties: {},
        }) as object,
      },
    };
  }

  private normalizeErrorMessage(message: string): string {
    const trimmed = message.trim();
    if (!trimmed) {
      return "";
    }

    try {
      const parsed = JSON.parse(trimmed) as {
        error?: { message?: string };
        message?: string;
      };
      if (typeof parsed.error?.message === "string") {
        return parsed.error.message;
      }
      if (typeof parsed.message === "string") {
        return parsed.message;
      }
    } catch {
      // Fall through to the raw response body when it is not JSON.
    }

    return trimmed.replace(/\s+/g, " ");
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
    const expandedMessages = this.expandToolResults(request.messages);
    const messages = expandedMessages.map((m) => this.chatMessageToOpenAIMessage(m));
    const body: Record<string, unknown> = {
      model: request.model || this.model,
      messages,
      stream: true,
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => this.chatToolToOpenAITool(t));
    }
    return body;
  }

  private getResponseReader(response: Response): ReadableStreamDefaultReader<Uint8Array> | null {
    return response.body?.getReader() ?? null;
  }

  private async *consumeStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    toolCallsByIndex: Map<number, AccumulatedToolCall>,
  ): AsyncIterable<ChatStreamEvent> {
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const events = this.parseStreamLine(line, toolCallsByIndex);
        for (const event of events) {
          yield event;
        }
      }
    }
  }

  private parseStreamLine(
    line: string,
    toolCallsByIndex: Map<number, AccumulatedToolCall>,
  ): ChatStreamEvent[] {
    if (!line.startsWith("data: ")) {
      return [];
    }

    const data = line.slice(6).trim();
    if (data === "[DONE]") {
      return [];
    }

    const chunk = this.parseStreamChunk(data);
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
        this.accumulateToolCall(tc, toolCallsByIndex);
      }
    }

    if (choice.finish_reason === "tool_calls") {
      const toolCalls = this.buildToolCalls(toolCallsByIndex);
      if (toolCalls.length > 0) {
        events.push({ type: "tool_calls", toolCalls });
      }
    }

    return events;
  }

  private parseStreamChunk(data: string): {
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
  } | null {
    try {
      return JSON.parse(data) as {
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
      };
    } catch {
      return null;
    }
  }

  private accumulateToolCall(
    tc: {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    },
    toolCallsByIndex: Map<number, AccumulatedToolCall>,
  ): void {
    const idx = tc.index ?? 0;
    let acc = toolCallsByIndex.get(idx);
    if (!acc) {
      acc = { name: "", argsString: "" };
      toolCallsByIndex.set(idx, acc);
    }
    if (tc.id) acc.id = tc.id;
    if (tc.function?.name) acc.name += tc.function.name;
    if (tc.function?.arguments != null) {
      acc.argsString += tc.function.arguments;
    }
  }

  private buildToolCalls(
    toolCallsByIndex: Map<number, AccumulatedToolCall>,
  ): ChatToolCall[] {
    const toolCalls: ChatToolCall[] = [];
    const indices = [...toolCallsByIndex.keys()].sort((a, b) => a - b);

    for (const index of indices) {
      const acc = toolCallsByIndex.get(index);
      if (!acc) {
        continue;
      }

      let args: Record<string, unknown> = {};
      if (acc.argsString) {
        try {
          args = JSON.parse(acc.argsString) as Record<string, unknown>;
        } catch {
          args = { raw: acc.argsString };
        }
      }

      toolCalls.push({
        id: acc.id,
        function: { name: acc.name || "", arguments: args },
      });
    }

    return toolCalls;
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
    const normalizedMessage = this.normalizeErrorMessage(originalError.message);

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
    if (response.status === 400 && this.isContextLengthError(normalizedMessage)) {
      return new ProviderContextLengthError(
        `Context length exceeded: ${normalizedMessage}`,
        originalError,
      );
    }
    if (response.status === 401) {
      return new ProviderAuthenticationError("Invalid xAI API key", originalError);
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
      return new ProviderRateLimitError(
        "xAI rate limit exceeded",
        Number.isNaN(retryAfterSeconds) ? undefined : retryAfterSeconds,
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

  private translateMessageError(msg: string, originalError: Error): ProviderError {
    if (this.isContextLengthError(msg)) {
      return new ProviderContextLengthError(
        `Context length exceeded: ${msg}`,
        originalError,
      );
    }

    if (msg && (msg.includes("AbortError") || msg.includes("aborted"))) {
      return new ProviderError("Request cancelled", originalError);
    }
    if (
      msg &&
      (msg.includes("ECONNREFUSED") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("fetch failed"))
    ) {
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
