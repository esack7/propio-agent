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
        ...(tc.thoughtSignature
          ? {
              extra_content: {
                google: {
                  thought_signature: tc.thoughtSignature,
                },
              },
            }
          : {}),
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
      if (
        response.status === 400 &&
        this.isContextLengthError(normalizedMessage)
      ) {
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
        const retryAfterSeconds = retryAfter
          ? parseInt(retryAfter, 10)
          : undefined;
        return new ProviderRateLimitError(
          "Gemini rate limit exceeded",
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
            ? `Gemini service error: ${normalizedMessage}`
            : "Gemini service error",
          originalError,
        );
      }
    }

    const msg = normalizedMessage || originalError.message;

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
      const expandedMessages = this.expandToolResults(request.messages);
      const messages = expandedMessages.map((m) =>
        this.chatMessageToOpenAIMessage(m),
      );
      const body: Record<string, unknown> = {
        model: effectiveModel,
        messages,
        stream: true,
      };
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map((t) => this.chatToolToOpenAITool(t));
      }

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

      const decoder = new TextDecoder();
      let buffer = "";
      const toolCallsByIndex = new Map<
        number,
        {
          id?: string;
          name: string;
          argsString: string;
          thoughtSignature?: string;
        }
      >();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;

          let chunk: {
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
          };
          try {
            chunk = JSON.parse(data) as typeof chunk;
          } catch {
            continue;
          }

          const choice = chunk.choices?.[0];
          if (!choice?.delta) continue;

          const delta = choice.delta;
          if (delta.content != null && delta.content !== "") {
            yield { type: "assistant_text", delta: delta.content };
          }

          const toolCallsDelta = delta.tool_calls ?? delta.toolCalls;
          if (toolCallsDelta && Array.isArray(toolCallsDelta)) {
            for (const tc of toolCallsDelta) {
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
              const thoughtSignature =
                tc.extra_content?.google?.thought_signature ??
                tc.thought_signature ??
                tc.thoughtSignature;
              if (thoughtSignature && !acc.thoughtSignature) {
                acc.thoughtSignature = thoughtSignature;
              }
            }
          }
        }
      }

      if (toolCallsByIndex.size > 0) {
        const toolCalls: ChatToolCall[] = [];
        const indices = [...toolCallsByIndex.keys()].sort((a, b) => a - b);
        for (const index of indices) {
          const acc = toolCallsByIndex.get(index)!;
          let args: Record<string, unknown> = {};
          if (acc.argsString) {
            try {
              args = JSON.parse(acc.argsString);
            } catch {
              args = { raw: acc.argsString };
            }
          }
          toolCalls.push({
            id: acc.id,
            thoughtSignature: acc.thoughtSignature,
            function: { name: acc.name || "", arguments: args },
          });
        }

        yield { type: "tool_calls", toolCalls };
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw this.translateError(error);
    }
  }
}
