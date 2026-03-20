import { LLMProvider } from "./interface.js";
import {
  ChatMessage,
  ChatRequest,
  ChatChunk,
  ChatTool,
  ChatToolCall,
  ProviderError,
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderModelNotFoundError,
} from "./types.js";

const XAI_API_URL = "https://api.x.ai/v1/chat/completions";

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

  async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    try {
      const expandedMessages = this.expandToolResults(request.messages);
      const messages = expandedMessages.map((m) =>
        this.chatMessageToOpenAIMessage(m),
      );
      const body: Record<string, unknown> = {
        model: request.model || this.model,
        messages,
        stream: true,
      };
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map((t) => this.chatToolToOpenAITool(t));
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      };

      const response = await fetch(XAI_API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
      });

      if (!response.ok) {
        throw this.translateError(
          new Error(`HTTP ${response.status}`),
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
        { id?: string; name: string; argsString: string }
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
          if (data === "[DONE]") return;

          let chunk: {
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
          try {
            chunk = JSON.parse(data) as typeof chunk;
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          if (!choice?.delta) continue;

          const delta = choice.delta;
          if (delta.content != null && delta.content !== "") {
            yield { delta: delta.content };
          }

          if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let acc = toolCallsByIndex.get(idx);
              if (!acc) {
                acc = { name: "", argsString: "" };
                toolCallsByIndex.set(idx, acc);
              }
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments != null)
                acc.argsString += tc.function.arguments;
            }
          }

          if (choice.finish_reason === "tool_calls") {
            const toolCalls: ChatToolCall[] = [];
            const indices = [...toolCallsByIndex.keys()].sort((a, b) => a - b);
            for (const i of indices) {
              const acc = toolCallsByIndex.get(i)!;
              let args: Record<string, any> = {};
              if (acc.argsString) {
                try {
                  args = JSON.parse(acc.argsString);
                } catch {
                  args = { raw: acc.argsString };
                }
              }
              toolCalls.push({
                id: acc.id,
                function: { name: acc.name || "", arguments: args },
              });
            }
            if (toolCalls.length > 0) {
              yield { delta: "", toolCalls };
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw this.translateError(error);
    }
  }

  private translateError(error: unknown, response?: Response): ProviderError {
    const originalError =
      error instanceof Error ? error : new Error(String(error));
    if (response) {
      if (response.status === 401) {
        return new ProviderAuthenticationError(
          "Invalid xAI API key",
          originalError,
        );
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const retryAfterSeconds = retryAfter
          ? parseInt(retryAfter, 10)
          : undefined;
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
        return new ProviderError("xAI service error", originalError);
      }
    }
    const msg = originalError.message;
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
        "Failed to connect to xAI API",
        originalError,
      );
    }
    return new ProviderError(
      originalError.message || "xAI request failed",
      originalError,
    );
  }
}
