import { LLMProvider, ProviderCapabilities } from "./interface.js";
import {
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  ChatTool,
  ChatToolCall,
  ProviderAuthenticationError,
  ProviderContextLengthError,
  ProviderError,
  ProviderModelNotFoundError,
  ProviderRateLimitError,
} from "./types.js";
import {
  accumulateOpenAIStreamToolCall,
  buildOpenAIChatCompletionRequestBody,
  buildOpenAIStreamToolCalls,
  applyOpenAIMessageCore,
  createOpenAIToolCall,
  createOpenAIToolDefinition,
  isAbortOrTransportError,
  isContextLengthError,
  parseJsonMaybe,
  normalizeErrorMessage,
  parseOpenAIStreamToolCallArguments,
  parseRetryAfterSeconds,
  readSseDataLines,
} from "./shared.js";

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

/**
 * Gemini implementation of LLMProvider using Google's OpenAI-compatible API.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  private readonly model: string;
  private readonly apiKey: string;

  private static readonly CONTEXT_WINDOWS: Record<string, number> = {
    "gemini-3.1-pro-preview": 1_048_576,
    "gemini-3-flash-preview": 1_048_576,
    "gemini-3.1-flash-lite-preview": 1_048_576,
  };
  private static readonly SUPPORTED_MODELS = new Set([
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
  ]);

  constructor(options: { model: string; apiKey?: string }) {
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
    this.model = this.validateModel(options.model);
    this.apiKey = apiKey;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      contextWindowTokens: GeminiProvider.CONTEXT_WINDOWS[this.model],
    };
  }

  private validateModel(model: string): string {
    if (!GeminiProvider.SUPPORTED_MODELS.has(model)) {
      throw new ProviderModelNotFoundError(
        model,
        `Unsupported Gemini model: ${model}. Supported models: ${[
          ...GeminiProvider.SUPPORTED_MODELS,
        ].join(", ")}`,
      );
    }

    return model;
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

  private chatMessageToOpenAIMessage(msg: ChatMessage): OpenAIMessage {
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

  private chatToolToOpenAITool(tool: ChatTool): OpenAITool {
    return createOpenAIToolDefinition(tool);
  }

  private translateError(error: unknown, response?: Response): ProviderError {
    const originalError =
      error instanceof Error ? error : new Error(String(error));
    const normalizedMessage = normalizeErrorMessage(originalError.message);

    if (response) {
      if (response.status === 400 && isContextLengthError(normalizedMessage)) {
        return new ProviderContextLengthError(
          `Context length exceeded: ${normalizedMessage}`,
          originalError,
        );
      }

      if (response.status === 401) {
        return new ProviderAuthenticationError(
          "Invalid Gemini API key",
          originalError,
        );
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const retryAfterSeconds = parseRetryAfterSeconds(retryAfter);
        return new ProviderRateLimitError(
          "Gemini rate limit exceeded",
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
            ? `Gemini service error: ${normalizedMessage}`
            : "Gemini service error",
          originalError,
        );
      }
    }

    const msg = normalizedMessage || originalError.message;

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
      return new ProviderError(
        "Failed to connect to Gemini API",
        originalError,
      );
    }

    return new ProviderError(
      originalError.message || "Gemini request failed",
      originalError,
    );
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    try {
      const effectiveModel = this.validateModel(request.model || this.model);
      const body = buildOpenAIChatCompletionRequestBody({
        request,
        model: effectiveModel,
        mapMessage: (msg) => this.chatMessageToOpenAIMessage(msg),
        mapTool: (tool) => this.chatToolToOpenAITool(tool),
      });

      const response = await fetch(GEMINI_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });

      if (!response.ok) {
        let errorBody = "";
        try {
          errorBody = await response.text();
        } catch {
          // ignore read failures
        }
        throw this.translateError(
          new Error(errorBody || `HTTP ${response.status}`),
          response,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw this.translateError(new Error("No response body"));
      }

      const toolCallsByIndex = new Map<
        number,
        {
          id?: string;
          name: string;
          argsString: string;
          thoughtSignature?: string;
        }
      >();

      let stopReason: any = "end_turn";

      for await (const data of readSseDataLines(reader)) {
        if (data === "[DONE]") {
          break;
        }

        const chunk = parseJsonMaybe<{
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
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
              }>;
              toolCalls?: Array<{
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
              }>;
            };
            finish_reason?: string;
          }>;
        }>(data);

        const choice = chunk?.choices?.[0];
        if (!choice?.delta) continue;

        // Capture stop reason and map from Gemini to normalized StopReason
        if (choice.finish_reason) {
          if (choice.finish_reason === "MAX_TOKENS") {
            stopReason = "max_tokens";
          } else if (choice.finish_reason === "STOP") {
            stopReason = "end_turn";
          } else if (choice.finish_reason === "TOOL_CALLS") {
            stopReason = "tool_use";
          } else if (
            choice.finish_reason === "SAFETY" ||
            choice.finish_reason === "RECITATION" ||
            choice.finish_reason === "OTHER"
          ) {
            stopReason = "error";
          }
        }

        const delta = choice.delta;
        if (delta.content != null && delta.content !== "") {
          yield { type: "assistant_text", delta: delta.content };
        }

        const toolCallsDelta = delta.tool_calls ?? delta.toolCalls;
        if (toolCallsDelta && Array.isArray(toolCallsDelta)) {
          for (const tc of toolCallsDelta) {
            accumulateOpenAIStreamToolCall(tc, toolCallsByIndex, () => ({
              name: "",
              argsString: "",
            }));
            const thoughtSignature =
              tc.extra_content?.google?.thought_signature ??
              tc.thought_signature ??
              tc.thoughtSignature;
            const idx = tc.index ?? 0;
            const acc = toolCallsByIndex.get(idx);
            if (acc && thoughtSignature && !acc.thoughtSignature) {
              acc.thoughtSignature = thoughtSignature;
            }
          }
        }
      }

      if (toolCallsByIndex.size > 0) {
        const toolCalls = buildOpenAIStreamToolCalls(
          toolCallsByIndex,
          (acc) => ({
            id: acc.id,
            thoughtSignature: acc.thoughtSignature,
            function: {
              name: acc.name || "",
              arguments: parseOpenAIStreamToolCallArguments(acc.argsString),
            },
          }),
        );

        yield { type: "tool_calls", toolCalls };
      }

      // Emit normalized terminal event (Phase 4.5)
      yield { type: "terminal", stopReason };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw this.translateError(error);
    }
  }
}
