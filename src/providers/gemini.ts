import {
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  ChatToolCall,
  ProviderAuthenticationError,
  ProviderError,
} from "./types.js";
import type { AgentDiagnosticEvent } from "../diagnostics.js";
import { withRetry } from "./withRetry.js";
import {
  accumulateOpenAIStreamToolCall,
  buildOpenAIChatCompletionRequestBody,
  buildOpenAIStreamToolCalls,
  applyOpenAIMessageCore,
  createOpenAIToolCall,
  parseJsonMaybe,
  parseOpenAIStreamToolCallArguments,
  readSseDataLines,
} from "./shared.js";
import {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleProviderOptions,
} from "./openAiCompatibleProvider.js";

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

interface OpenAIMessageContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface OpenAIMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | OpenAIMessageContentPart[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    extra_content?: {
      google?: {
        thought_signature?: string;
      };
    };
  }>;
  tool_call_id?: string;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

interface GeminiToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
  thought_signature?: string;
  thoughtSignature?: string;
}

interface GeminiAccumulatedToolCall {
  id?: string;
  name: string;
  argsString: string;
  thoughtSignature?: string;
}

interface GeminiStreamChoice {
  delta?: {
    content?: string;
    tool_calls?: GeminiToolCallDelta[];
    toolCalls?: GeminiToolCallDelta[];
  };
  finish_reason?: string;
}

/**
 * Gemini implementation of LLMProvider using Google's OpenAI-compatible API.
 */
export class GeminiProvider extends OpenAiCompatibleProvider {
  readonly name = "gemini";
  private readonly model: string;
  private readonly apiKey: string;
  private readonly retryConfig?: {
    maxRetries: number;
    consecutive529Limit: number;
  };
  private readonly onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;

  constructor(options: OpenAiCompatibleProviderOptions) {
    super();
    const apiKey =
      options.apiKey ??
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_API_KEY ??
      "";
    if (!apiKey || apiKey.trim() === "") {
      throw new ProviderAuthenticationError(
        "Gemini API key is required. Set GEMINI_API_KEY or GOOGLE_API_KEY, or pass apiKey in options.",
      );
    }
    this.model = options.model;
    this.configureCapabilities(options.contextWindowTokens);
    this.apiKey = apiKey;
    this.retryConfig = options.retryConfig;
    this.onDiagnosticEvent = options.onDiagnosticEvent;
  }

  private imageToUrl(image: Uint8Array | string): string {
    if (typeof image === "string") {
      if (image.startsWith("data:")) {
        return image;
      }
      if (/^https?:\/\//i.test(image)) {
        return image;
      }
      return `data:image/png;base64,${image}`;
    }

    return `data:image/png;base64,${Buffer.from(image).toString("base64")}`;
  }

  protected chatMessageToOpenAIMessage(msg: ChatMessage): OpenAIMessage {
    const role = msg.role as OpenAIMessage["role"];
    const out: OpenAIMessage = {
      role,
      content: msg.content ?? "",
    };

    if (msg.role === "user" && msg.images && msg.images.length > 0) {
      const parts: OpenAIMessageContentPart[] = [];
      if (msg.content) {
        parts.push({ type: "text", text: msg.content });
      }
      for (const image of msg.images) {
        parts.push({
          type: "image_url",
          image_url: {
            url: this.imageToUrl(image),
          },
        });
      }
      out.content = parts;
    }

    applyOpenAIMessageCore(out, msg);
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      out.tool_calls = msg.toolCalls.map((tc) =>
        createOpenAIToolCall(
          tc,
          tc.thoughtSignature
            ? {
                extra_content: {
                  google: {
                    thought_signature: tc.thoughtSignature,
                  },
                },
              }
            : undefined,
        ),
      );
    }

    return out;
  }

  protected translateError(
    error: unknown,
    response?: Response,
    _responseBody?: string,
  ): ProviderError {
    return this.translateStandardOpenAiError(error, response, {
      model: this.model,
      authenticationMessage: "Invalid Gemini API key",
      rateLimitMessage: "Gemini rate limit exceeded",
      serviceErrorMessage: "Gemini service error",
      connectionErrorMessage: "Failed to connect to Gemini API",
      requestFailedMessage: "Gemini request failed",
    });
  }

  private mapFinishReason(finishReason: string): string {
    if (finishReason === "MAX_TOKENS") return "max_tokens";
    if (finishReason === "STOP") return "end_turn";
    if (finishReason === "TOOL_CALLS") return "tool_use";
    if (
      finishReason === "SAFETY" ||
      finishReason === "RECITATION" ||
      finishReason === "OTHER"
    )
      return "error";
    return "end_turn";
  }

  private extractThoughtSignature(toolCall: {
    extra_content?: { google?: { thought_signature?: string } };
    thought_signature?: string;
    thoughtSignature?: string;
  }): string | undefined {
    return (
      toolCall.extra_content?.google?.thought_signature ??
      toolCall.thought_signature ??
      toolCall.thoughtSignature
    );
  }

  private accumulateGeminiThoughtSignature(
    toolCall: GeminiToolCallDelta,
    toolCallsByIndex: Map<number, GeminiAccumulatedToolCall>,
  ): void {
    const thoughtSignature = this.extractThoughtSignature(toolCall);
    const index = toolCall.index ?? 0;
    const accumulated = toolCallsByIndex.get(index);
    if (accumulated && thoughtSignature && !accumulated.thoughtSignature) {
      accumulated.thoughtSignature = thoughtSignature;
    }
  }

  private processGeminiToolCallsDelta(
    toolCallsDelta: GeminiToolCallDelta[] | undefined,
    toolCallsByIndex: Map<number, GeminiAccumulatedToolCall>,
  ): void {
    if (!toolCallsDelta || !Array.isArray(toolCallsDelta)) {
      return;
    }

    for (const toolCall of toolCallsDelta) {
      accumulateOpenAIStreamToolCall(toolCall, toolCallsByIndex, () => ({
        name: "",
        argsString: "",
      }));
      this.accumulateGeminiThoughtSignature(toolCall, toolCallsByIndex);
    }
  }

  private buildGeminiToolCallsEvent(
    toolCallsByIndex: Map<number, GeminiAccumulatedToolCall>,
  ): ChatStreamEvent | null {
    if (toolCallsByIndex.size === 0) {
      return null;
    }

    return {
      type: "tool_calls",
      toolCalls: buildOpenAIStreamToolCalls(toolCallsByIndex, (acc) => ({
        id: acc.id,
        thoughtSignature: acc.thoughtSignature,
        function: {
          name: acc.name || "",
          arguments: parseOpenAIStreamToolCallArguments(acc.argsString),
        },
      })),
    };
  }

  private parseGeminiStreamChunk(
    data: string,
    toolCallsByIndex: Map<number, GeminiAccumulatedToolCall>,
  ): { events: ChatStreamEvent[]; stopReason?: string; done: boolean } {
    if (data === "[DONE]") {
      return { events: [], done: true };
    }

    const choice = parseJsonMaybe<{ choices?: GeminiStreamChoice[] }>(data)
      ?.choices?.[0];
    if (!choice?.delta) {
      return { events: [], done: false };
    }

    const events: ChatStreamEvent[] = [];
    if (choice.delta.content != null && choice.delta.content !== "") {
      events.push({ type: "assistant_text", delta: choice.delta.content });
    }
    this.processGeminiToolCallsDelta(
      choice.delta.tool_calls ?? choice.delta.toolCalls,
      toolCallsByIndex,
    );

    return {
      events,
      stopReason: choice.finish_reason
        ? this.mapFinishReason(choice.finish_reason)
        : undefined,
      done: false,
    };
  }

  private async createGeminiStreamReader(
    request: ChatRequest,
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const effectiveModel = request.model || this.model;
    const body = buildOpenAIChatCompletionRequestBody({
      request,
      model: effectiveModel,
      mapMessage: (msg) => this.chatMessageToOpenAIMessage(msg),
      mapTool: (tool) => this.chatToolToOpenAITool(tool),
    });
    const response = await withRetry(
      () => this.fetchGeminiStream(body, request.signal),
      this.buildRetryOptions(
        request,
        this.model,
        this.retryConfig,
        this.onDiagnosticEvent,
      ),
    );
    const reader = response.body?.getReader();
    if (!reader) {
      throw this.translateError(new Error("No response body"));
    }
    return reader;
  }

  private async fetchGeminiStream(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const res = await fetch(GEMINI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let errorBody = "";
      try {
        errorBody = await res.text();
      } catch {
        /* ignore read failures */
      }
      throw this.translateError(
        new Error(errorBody || `HTTP ${res.status}`),
        res,
      );
    }
    return res;
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    try {
      const reader = await this.createGeminiStreamReader(request);
      const toolCallsByIndex = new Map<number, GeminiAccumulatedToolCall>();
      let stopReason: any = "end_turn";

      for await (const data of readSseDataLines(reader)) {
        const result = this.parseGeminiStreamChunk(data, toolCallsByIndex);
        if (result.stopReason) {
          stopReason = result.stopReason;
        }
        yield* result.events;
        if (result.done) {
          break;
        }
      }

      const toolCallsEvent = this.buildGeminiToolCallsEvent(toolCallsByIndex);
      if (toolCallsEvent) {
        yield toolCallsEvent;
      }

      yield { type: "terminal", stopReason };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw this.translateError(error);
    }
  }
}
