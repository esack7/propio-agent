import { ProviderCapabilities } from "./interface.js";
import {
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  ChatToolCall,
  ProviderAuthenticationError,
  ProviderError,
  ProviderModelNotFoundError,
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
    this.model = this.validateModel(options.model);
    this.apiKey = apiKey;
    this.retryConfig = options.retryConfig;
    this.onDiagnosticEvent = options.onDiagnosticEvent;
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
      const effectiveModel = this.validateModel(request.model || this.model);
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

        if (choice.finish_reason) {
          stopReason = this.mapFinishReason(choice.finish_reason);
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
            const thoughtSignature = this.extractThoughtSignature(tc);
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
