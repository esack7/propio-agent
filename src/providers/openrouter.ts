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
import type { AgentDiagnosticEvent } from "../diagnostics.js";
import type { OpenRouterRoutingConfig } from "./config.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DSML_TOOL_CALL_START_TOKENS = [
  "<｜DSML｜tool_calls>",
  "<｜DSML｜function_calls>",
] as const;
const DSML_TOOL_CALL_END_TOKENS = [
  "</｜DSML｜tool_calls>",
  "</｜DSML｜function_calls>",
] as const;
const DSML_TOOL_CALL_BLOCK_REGEX =
  /<｜DSML｜(?:tool_calls|function_calls)>(.*?)<\/｜DSML｜(?:tool_calls|function_calls)>/gs;
const DSML_TOOL_CALL_BLOCK_AT_START_REGEX =
  /^<｜DSML｜(?:tool_calls|function_calls)>(.*?)<\/｜DSML｜(?:tool_calls|function_calls)>/s;
const DSML_INVOKE_REGEX =
  /<｜DSML｜invoke\s+name="([^"]+)"\s*>(.*?)<\/｜DSML｜invoke>/gs;
const DSML_PARAMETER_REGEX =
  /<｜DSML｜parameter\s+name="([^"]+)"\s+string="(?:true|false)"\s*>(.*?)<\/｜DSML｜parameter>/gs;

interface OpenRouterErrorMetadata {
  retry_after_seconds?: number;
  provider_name?: string;
  raw?: string;
}

interface OpenRouterErrorEnvelope {
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
    metadata?: OpenRouterErrorMetadata;
  };
}

/** OpenAI-compatible message format for API request */
interface OpenAIMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  reasoning_content?: string;
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
 * OpenRouter implementation of LLMProvider using native fetch and OpenAI-compatible API.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter";
  private readonly model: string;
  private readonly apiKey: string;
  private readonly httpReferer?: string;
  private readonly xTitle?: string;
  private readonly providerRouting?: OpenRouterRoutingConfig;
  private readonly fallbackModels?: string[];
  private readonly debugEchoUpstreamBody?: boolean;
  private readonly debugLoggingEnabled: boolean;
  private readonly onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;

  private static readonly CONTEXT_WINDOWS: Record<string, number> = {
    "anthropic/claude-sonnet-4": 200000,
    "anthropic/claude-3.5-sonnet": 200000,
    "anthropic/claude-3-opus": 200000,
    "anthropic/claude-3-haiku": 200000,
    "google/gemini-2.5-pro-preview": 1000000,
    "google/gemini-2.0-flash": 1000000,
    "openai/gpt-4o": 128000,
    "openai/gpt-4-turbo": 128000,
    "openai/o3-mini": 200000,
    "meta-llama/llama-3.3-70b-instruct": 131072,
    "deepseek/deepseek-v4-pro": 1_000_000,
    "deepseek/deepseek-v4-flash": 1_000_000,
  };

  private static readonly DEFAULT_CONTEXT_WINDOW = 128000;

  constructor(options: {
    model: string;
    apiKey?: string;
    httpReferer?: string;
    xTitle?: string;
    provider?: OpenRouterRoutingConfig;
    fallbackModels?: string[];
    debugEchoUpstreamBody?: boolean;
    debugLoggingEnabled?: boolean;
    onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;
  }) {
    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    if (!apiKey || apiKey.trim() === "") {
      throw new ProviderAuthenticationError(
        "OpenRouter API key is required. Set OPENROUTER_API_KEY or pass apiKey in options.",
      );
    }
    this.model = options.model;
    this.apiKey = apiKey;
    this.httpReferer = options.httpReferer;
    this.xTitle = options.xTitle;
    this.providerRouting = options.provider;
    this.fallbackModels = options.fallbackModels;
    this.debugEchoUpstreamBody = options.debugEchoUpstreamBody;
    this.debugLoggingEnabled = options.debugLoggingEnabled ?? false;
    this.onDiagnosticEvent = options.onDiagnosticEvent;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      contextWindowTokens:
        OpenRouterProvider.CONTEXT_WINDOWS[this.model] ??
        OpenRouterProvider.DEFAULT_CONTEXT_WINDOW,
    };
  }

  /**
   * Expands batched tool results into individual tool messages.
   * OpenAI/OpenRouter expects one message per tool result with tool_call_id.
   */
  private expandToolResults(messages: ChatMessage[]): ChatMessage[] {
    const expanded: ChatMessage[] = [];

    for (const msg of messages) {
      // If this is a batched tool result message, expand it
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
        // Not a batched tool result, keep as is
        expanded.push(msg);
      }
    }

    return expanded;
  }

  private chatMessageToOpenAIMessage(msg: ChatMessage): OpenAIMessage {
    const role = msg.role as OpenAIMessage["role"];
    const out: OpenAIMessage = { role, content: msg.content ?? "" };
    if (msg.reasoningContent !== undefined) {
      out.reasoning_content = msg.reasoningContent;
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
      }));
    }
    if (msg.role === "tool" && msg.toolCallId) {
      out.tool_call_id = msg.toolCallId;
    }
    return out;
  }

  private openAIMessageToChatMessage(msg: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  }): ChatMessage {
    const content = msg.content ?? "";
    const toolCalls: ChatToolCall[] = [];
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function;
        let args: Record<string, unknown> = {};
        if (fn?.arguments) {
          try {
            args =
              typeof fn.arguments === "string"
                ? JSON.parse(fn.arguments)
                : fn.arguments;
          } catch {
            args = { raw: fn.arguments };
          }
        }
        toolCalls.push({
          id: tc.id,
          function: {
            name: fn?.name ?? "",
            arguments: args as Record<string, any>,
          },
        });
      }
    }
    const chatMsg: ChatMessage = { role: "assistant", content };
    if (msg.reasoning_content != null) {
      chatMsg.reasoningContent = msg.reasoning_content;
    }
    if (toolCalls.length > 0) {
      chatMsg.toolCalls = toolCalls;
    }
    return chatMsg;
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

  private emitDiagnostic(event: AgentDiagnosticEvent): void {
    this.onDiagnosticEvent?.(event);
  }

  private buildRequestBody(
    request: ChatRequest,
    includeTools: boolean,
  ): Record<string, unknown> {
    const expandedMessages = this.expandToolResults(request.messages);
    const messages = expandedMessages.map((m) =>
      this.chatMessageToOpenAIMessage(m),
    );

    const body: Record<string, unknown> = {
      model: request.model || this.model,
      messages,
      stream: true,
    };

    if (includeTools && request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => this.chatToolToOpenAITool(t));
    }

    if (this.providerRouting) {
      const provider: Record<string, unknown> = {};
      if (this.providerRouting.allowFallbacks !== undefined) {
        provider.allow_fallbacks = this.providerRouting.allowFallbacks;
      }
      if (this.providerRouting.order !== undefined) {
        provider.order = [...this.providerRouting.order];
      }
      if (this.providerRouting.requireParameters !== undefined) {
        provider.require_parameters = this.providerRouting.requireParameters;
      }
      if (Object.keys(provider).length > 0) {
        body.provider = provider;
      }
    }

    if (this.fallbackModels && this.fallbackModels.length > 0) {
      body.models = [...this.fallbackModels];
    }

    if (this.debugEchoUpstreamBody && this.debugLoggingEnabled) {
      body.debug = { echo_upstream_body: true };
    }

    return body;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.httpReferer) headers["HTTP-Referer"] = this.httpReferer;
    if (this.xTitle) headers["X-OpenRouter-Title"] = this.xTitle;
    return headers;
  }

  private async fetchCompletion(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    return await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal,
    });
  }

  private async readResponseText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  private longestSuffixOverlap(text: string, token: string): number {
    const maxLength = Math.min(text.length, token.length);
    for (let length = maxLength; length > 0; length--) {
      if (token.startsWith(text.slice(text.length - length))) {
        return length;
      }
    }
    return 0;
  }

  private findDsmlStartTokenIndex(text: string): number {
    let earliest = -1;
    for (const token of DSML_TOOL_CALL_START_TOKENS) {
      const index = text.indexOf(token);
      if (index !== -1 && (earliest === -1 || index < earliest)) {
        earliest = index;
      }
    }
    return earliest;
  }

  private parseDsmlToolCalls(text: string): ChatToolCall[] {
    const toolCalls: ChatToolCall[] = [];

    for (const blockMatch of text.matchAll(DSML_TOOL_CALL_BLOCK_REGEX)) {
      const block = blockMatch[1] ?? "";
      for (const invokeMatch of block.matchAll(DSML_INVOKE_REGEX)) {
        const invokeName = invokeMatch[1] ?? "";
        const invokeBody = invokeMatch[2] ?? "";
        const args: Record<string, unknown> = {};

        for (const parameterMatch of invokeBody.matchAll(
          DSML_PARAMETER_REGEX,
        )) {
          const paramName = parameterMatch[1] ?? "";
          const rawValue = parameterMatch[2] ?? "";
          const fullTag = parameterMatch[0];
          const stringFlag = /string="(true|false)"/.exec(fullTag)?.[1];
          if (!paramName) continue;

          if (stringFlag === "true") {
            args[paramName] = rawValue;
            continue;
          }

          try {
            args[paramName] = JSON.parse(rawValue);
          } catch {
            args[paramName] = rawValue;
          }
        }

        toolCalls.push({
          id: `call_${invokeName}_${Date.now()}_${toolCalls.length}`,
          function: {
            name: invokeName,
            arguments: args,
          },
        });
      }
    }

    return toolCalls;
  }

  private consumeDsmlBuffer(buffer: string): {
    remainingBuffer: string;
    events: ChatStreamEvent[];
    sawUsableOutput: boolean;
  } {
    const events: ChatStreamEvent[] = [];
    let remainingBuffer = buffer;
    let sawUsableOutput = false;

    while (remainingBuffer.length > 0) {
      const startIndex = this.findDsmlStartTokenIndex(remainingBuffer);

      if (startIndex === -1) {
        const overlap = DSML_TOOL_CALL_START_TOKENS.reduce(
          (max, token) =>
            Math.max(max, this.longestSuffixOverlap(remainingBuffer, token)),
          0,
        );
        const emitLength = remainingBuffer.length - overlap;
        if (emitLength > 0) {
          const content = remainingBuffer.slice(0, emitLength);
          events.push({ type: "assistant_text", delta: content });
          if (content.trim().length > 0) {
            sawUsableOutput = true;
          }
          remainingBuffer = remainingBuffer.slice(emitLength);
          continue;
        }
        break;
      }

      if (startIndex > 0) {
        const prefix = remainingBuffer.slice(0, startIndex);
        if (prefix.length > 0) {
          events.push({ type: "assistant_text", delta: prefix });
          if (prefix.trim().length > 0) {
            sawUsableOutput = true;
          }
        }
        remainingBuffer = remainingBuffer.slice(startIndex);
        continue;
      }

      const blockMatch = remainingBuffer.match(
        DSML_TOOL_CALL_BLOCK_AT_START_REGEX,
      );
      if (!blockMatch || blockMatch.index !== 0) {
        break;
      }

      const blockText = blockMatch[0] ?? "";
      const toolCalls = this.parseDsmlToolCalls(blockText);
      if (toolCalls.length > 0) {
        events.push({ type: "tool_calls", toolCalls });
        sawUsableOutput = true;
      }
      remainingBuffer = remainingBuffer.slice(blockText.length);
    }

    return { remainingBuffer, events, sawUsableOutput };
  }

  private async *streamResponse(
    response: Response,
    options: {
      parseDsmlToolCalls: boolean;
      expectUsableOutput: boolean;
      request: ChatRequest;
    },
  ): AsyncIterable<ChatStreamEvent> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw this.translateError(new Error("No response body"));
    }

    const decoder = new TextDecoder();
    let lineBuffer = "";
    let contentBuffer = "";
    let reasoningContent = "";
    let sawUsableOutput = false;
    let reachedDone = false;
    const structuredToolCallsByIndex = new Map<
      number,
      { id?: string; name: string; argsString: string }
    >();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          reachedDone = true;
          break;
        }

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string;
              reasoning_content?: string;
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
        if (delta.reasoning_content != null && delta.reasoning_content !== "") {
          reasoningContent += delta.reasoning_content;
        }

        if (delta.content != null && delta.content !== "") {
          if (options.parseDsmlToolCalls) {
            contentBuffer += delta.content;
            const consumed = this.consumeDsmlBuffer(contentBuffer);
            contentBuffer = consumed.remainingBuffer;
            for (const event of consumed.events) {
              if (
                "type" in event &&
                event.type === "tool_calls" &&
                reasoningContent.length > 0
              ) {
                yield {
                  type: "tool_calls",
                  toolCalls: event.toolCalls,
                  reasoningContent,
                };
                continue;
              }
              yield event;
            }
            sawUsableOutput ||= consumed.sawUsableOutput;
          } else {
            yield { type: "assistant_text", delta: delta.content };
            if (delta.content.trim().length > 0) {
              sawUsableOutput = true;
            }
          }
        }

        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let acc = structuredToolCallsByIndex.get(idx);
            if (!acc) {
              acc = { name: "", argsString: "" };
              structuredToolCallsByIndex.set(idx, acc);
            }
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments != null) {
              acc.argsString += tc.function.arguments;
            }
          }
        }

        if (choice.finish_reason === "tool_calls") {
          const toolCalls: ChatToolCall[] = [];
          const indices = [...structuredToolCallsByIndex.keys()].sort(
            (a, b) => a - b,
          );
          for (const i of indices) {
            const acc = structuredToolCallsByIndex.get(i)!;
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
              function: { name: acc.name || "", arguments: args },
            });
          }
          if (toolCalls.length > 0) {
            yield {
              type: "tool_calls",
              toolCalls,
              ...(reasoningContent.length > 0 ? { reasoningContent } : {}),
            };
            sawUsableOutput = true;
          }
        }
      }

      if (reachedDone) {
        break;
      }
    }

    if (options.parseDsmlToolCalls && contentBuffer.length > 0) {
      const consumed = this.consumeDsmlBuffer(contentBuffer);
      contentBuffer = consumed.remainingBuffer;
      for (const event of consumed.events) {
        if (
          "type" in event &&
          event.type === "tool_calls" &&
          reasoningContent.length > 0
        ) {
          yield {
            type: "tool_calls",
            toolCalls: event.toolCalls,
            reasoningContent,
          };
          continue;
        }
        yield event;
      }
      sawUsableOutput ||= consumed.sawUsableOutput;
    }

    if (options.expectUsableOutput && !sawUsableOutput) {
      yield {
        type: "status",
        status:
          "OpenRouter returned no usable assistant output; retrying would not help.",
        phase: "provider fallback",
      };
      throw new ProviderError("OpenRouter returned no usable assistant output");
    }
  }

  private shouldRetryWithoutTools(
    request: ChatRequest,
    response: Response,
  ): boolean {
    return (
      Boolean(request.tools && request.tools.length > 0) &&
      (response.status === 429 || response.status === 503)
    );
  }

  private emitRetryDiagnostic(request: ChatRequest, response: Response): void {
    this.emitDiagnostic({
      type: "provider_retry",
      provider: this.name,
      model: request.model || this.model,
      iteration: request.iteration ?? 0,
      reason: `OpenRouter upstream HTTP ${response.status}`,
      disabledTools: true,
    });
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    try {
      const primaryBody = this.buildRequestBody(request, true);
      const response = await this.fetchCompletion(primaryBody, request.signal);

      if (!response.ok) {
        const errorBody = await this.readResponseText(response);
        if (this.shouldRetryWithoutTools(request, response)) {
          this.emitRetryDiagnostic(request, response);
          yield {
            type: "status",
            status: "Retrying without tools after OpenRouter upstream failure",
            phase: "provider fallback",
          };

          const retryBody = this.buildRequestBody(request, false);
          const retryResponse = await this.fetchCompletion(
            retryBody,
            request.signal,
          );
          if (!retryResponse.ok) {
            const retryErrorBody = await this.readResponseText(retryResponse);
            throw this.translateError(
              new Error(retryErrorBody || `HTTP ${retryResponse.status}`),
              retryResponse,
              retryErrorBody,
            );
          }

          yield* this.streamResponse(retryResponse, {
            parseDsmlToolCalls: Boolean(
              request.tools && request.tools.length > 0,
            ),
            expectUsableOutput: Boolean(
              request.tools && request.tools.length > 0,
            ),
            request,
          });
          return;
        }

        throw this.translateError(
          new Error(errorBody || `HTTP ${response.status}`),
          response,
          errorBody,
        );
      }

      yield* this.streamResponse(response, {
        parseDsmlToolCalls: Boolean(request.tools && request.tools.length > 0),
        expectUsableOutput: Boolean(request.tools && request.tools.length > 0),
        request,
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw this.translateError(error);
    }
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

  private parseOpenRouterErrorBody(responseBody?: string): {
    message?: string;
    providerName?: string;
    retryAfterSeconds?: number;
  } {
    if (!responseBody) {
      return {};
    }

    let parsed: OpenRouterErrorEnvelope | undefined;
    try {
      parsed = JSON.parse(responseBody) as OpenRouterErrorEnvelope;
    } catch {
      return {};
    }

    const metadata = parsed.error?.metadata;
    const details: {
      message?: string;
      providerName?: string;
      retryAfterSeconds?: number;
    } = {};

    if (typeof parsed.error?.message === "string") {
      details.message = parsed.error.message;
    }

    if (typeof metadata?.provider_name === "string") {
      details.providerName = metadata.provider_name;
    }

    if (typeof metadata?.retry_after_seconds === "number") {
      details.retryAfterSeconds = metadata.retry_after_seconds;
    }

    if (typeof metadata?.raw === "string") {
      try {
        const raw = JSON.parse(metadata.raw) as {
          error?: {
            message?: string;
            metadata?: { retry_after_seconds?: number };
          };
          provider_name?: string;
        };
        if (typeof raw.provider_name === "string") {
          details.providerName = raw.provider_name;
        }
        if (typeof raw.error?.message === "string") {
          details.message = raw.error.message;
        }
        if (typeof raw.error?.metadata?.retry_after_seconds === "number") {
          details.retryAfterSeconds = raw.error.metadata.retry_after_seconds;
        }
      } catch {
        // If the nested raw payload is not JSON, keep the outer envelope values.
      }
    }

    return details;
  }

  private translateError(
    error: unknown,
    response?: Response,
    responseBody?: string,
  ): ProviderError {
    const originalError =
      error instanceof Error ? error : new Error(String(error));
    if (response) {
      const errorInfo = this.parseOpenRouterErrorBody(responseBody);
      const upstreamDetail = (
        includeRetryAfter: boolean,
      ): string | undefined => {
        const details: string[] = [];
        const upstreamMessageParts: string[] = [];
        if (typeof errorInfo.providerName === "string") {
          upstreamMessageParts.push(errorInfo.providerName);
        }
        if (typeof errorInfo.message === "string") {
          upstreamMessageParts.push(errorInfo.message);
        }
        if (upstreamMessageParts.length > 0) {
          details.push(upstreamMessageParts.join(": "));
        }
        if (
          includeRetryAfter &&
          typeof errorInfo.retryAfterSeconds === "number"
        ) {
          details.push(`retry after ${errorInfo.retryAfterSeconds}s`);
        }
        return details.length > 0 ? details.join("; ") : undefined;
      };
      if (
        response.status === 400 &&
        this.isContextLengthError(originalError.message)
      ) {
        return new ProviderContextLengthError(
          `Context length exceeded: ${originalError.message}`,
          originalError,
        );
      }
      if (response.status === 401) {
        return new ProviderAuthenticationError(
          "Invalid OpenRouter API key",
          originalError,
        );
      }
      if (response.status === 429) {
        const retryAfter = response.headers?.get("retry-after");
        const retryAfterSeconds =
          errorInfo.retryAfterSeconds ??
          (retryAfter ? parseInt(retryAfter, 10) : undefined);
        const detail = upstreamDetail(true);
        const message = detail
          ? `OpenRouter rate limit exceeded (${detail})`
          : "OpenRouter rate limit exceeded";
        return new ProviderRateLimitError(
          message,
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
      if (response.status === 402) {
        return new ProviderError(
          "Insufficient OpenRouter credits",
          originalError,
        );
      }
      if (response.status === 503) {
        const detail = upstreamDetail(true);
        return new ProviderError(
          detail
            ? `OpenRouter upstream provider unavailable (${detail})`
            : "OpenRouter service error",
          originalError,
        );
      }
      if (response.status >= 500 && response.status < 600) {
        return new ProviderError("OpenRouter service error", originalError);
      }
    }
    const msg = originalError.message;

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
        "Failed to connect to OpenRouter API",
        originalError,
      );
    }
    return new ProviderError(
      originalError.message || "OpenRouter request failed",
      originalError,
    );
  }
}
