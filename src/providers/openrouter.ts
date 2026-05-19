import { ProviderCapabilities } from "./interface.js";
import {
  ChatRequest,
  ChatStreamEvent,
  ChatToolCall,
  ProviderError,
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderModelNotFoundError,
  ProviderContextLengthError,
  ProviderCapacityError,
} from "./types.js";
import {
  accumulateOpenAIStreamToolCall,
  buildOpenAIChatCompletionRequestBody,
  buildOpenAIStreamToolCalls,
  createProviderRetryOptions,
  isContextLengthError,
  parseJsonMaybe,
  parseOpenAIStreamToolCallArguments,
  parseRetryAfterSeconds,
  readSseDataLines,
} from "./shared.js";
import { withRetry } from "./withRetry.js";
import type { AgentDiagnosticEvent } from "../diagnostics.js";
import type { OpenRouterRoutingConfig } from "./config.js";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider.js";

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

/**
 * OpenRouter implementation of LLMProvider using native fetch and OpenAI-compatible API.
 */
export class OpenRouterProvider extends OpenAiCompatibleProvider {
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
  private readonly retryConfig?: {
    maxRetries: number;
    consecutive529Limit: number;
    baseDelayMs?: number;
  };

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
    retryConfig?: {
      maxRetries: number;
      consecutive529Limit: number;
      baseDelayMs?: number;
    };
  }) {
    super();
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
    this.retryConfig = options.retryConfig;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      contextWindowTokens:
        OpenRouterProvider.CONTEXT_WINDOWS[this.model] ??
        OpenRouterProvider.DEFAULT_CONTEXT_WINDOW,
    };
  }

  private emitDiagnostic(event: AgentDiagnosticEvent): void {
    this.onDiagnosticEvent?.(event);
  }

  private buildRequestBody(
    request: ChatRequest,
    includeTools: boolean,
  ): Record<string, unknown> {
    return buildOpenAIChatCompletionRequestBody({
      request,
      model: this.model,
      mapMessage: (msg) => this.chatMessageToOpenAIMessage(msg),
      mapTool: (tool) => this.chatToolToOpenAITool(tool),
      includeTools,
      extra: (body) => {
        if (this.providerRouting) {
          const provider: Record<string, unknown> = {};
          if (this.providerRouting.allowFallbacks !== undefined) {
            provider.allow_fallbacks = this.providerRouting.allowFallbacks;
          }
          if (this.providerRouting.order !== undefined) {
            provider.order = [...this.providerRouting.order];
          }
          if (this.providerRouting.requireParameters !== undefined) {
            provider.require_parameters =
              this.providerRouting.requireParameters;
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
      },
    });
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

  private buildStructuredToolCallsEvent(
    toolCallsByIndex: Map<
      number,
      { id?: string; name: string; argsString: string }
    >,
    reasoningContent: string,
  ): ChatStreamEvent | null {
    const toolCalls = buildOpenAIStreamToolCalls(toolCallsByIndex, (acc) => ({
      id: acc.id,
      function: {
        name: acc.name || "",
        arguments: parseOpenAIStreamToolCallArguments(acc.argsString),
      },
    }));
    if (toolCalls.length === 0) return null;
    return {
      type: "tool_calls",
      toolCalls,
      ...(reasoningContent.length > 0 ? { reasoningContent } : {}),
    };
  }

  private mapOpenRouterFinishReason(finishReason: string): string {
    if (finishReason === "length") return "max_tokens";
    if (finishReason === "stop") return "end_turn";
    if (finishReason === "tool_calls") return "tool_use";
    if (finishReason === "content_filter") return "error";
    return "end_turn";
  }

  private flushDsmlBuffer(
    contentBuffer: string,
    reasoningContent: string,
  ): {
    events: ChatStreamEvent[];
    remainingBuffer: string;
    sawUsableOutput: boolean;
  } {
    const consumed = this.consumeDsmlBuffer(contentBuffer);
    const events: ChatStreamEvent[] = consumed.events.map((event) => {
      if (
        "type" in event &&
        event.type === "tool_calls" &&
        reasoningContent.length > 0
      ) {
        return {
          type: "tool_calls" as const,
          toolCalls: event.toolCalls,
          reasoningContent,
        };
      }
      return event;
    });
    return {
      events,
      remainingBuffer: consumed.remainingBuffer,
      sawUsableOutput: consumed.sawUsableOutput,
    };
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

    let contentBuffer = "";
    let reasoningContent = "";
    let sawUsableOutput = false;
    let reachedDone = false;
    let stopReason: any = "end_turn";
    const structuredToolCallsByIndex = new Map<
      number,
      { id?: string; name: string; argsString: string }
    >();

    for await (const data of readSseDataLines(reader)) {
      if (data === "[DONE]") {
        reachedDone = true;
        break;
      }

      const chunk = parseJsonMaybe<{
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
      }>(data);
      const choice = chunk?.choices?.[0];
      if (!choice?.delta) continue;

      if (choice.finish_reason) {
        stopReason = this.mapOpenRouterFinishReason(choice.finish_reason);
      }

      const delta = choice.delta;
      if (delta.reasoning_content) reasoningContent += delta.reasoning_content;

      if (delta.content) {
        if (options.parseDsmlToolCalls) {
          contentBuffer += delta.content;
          const flushed = this.flushDsmlBuffer(contentBuffer, reasoningContent);
          contentBuffer = flushed.remainingBuffer;
          for (const event of flushed.events) yield event;
          sawUsableOutput ||= flushed.sawUsableOutput;
        } else {
          yield { type: "assistant_text", delta: delta.content };
          if (delta.content.trim()) sawUsableOutput = true;
        }
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          accumulateOpenAIStreamToolCall(
            tc,
            structuredToolCallsByIndex,
            () => ({ name: "", argsString: "" }),
          );
        }
      }

      if (choice.finish_reason === "tool_calls") {
        const event = this.buildStructuredToolCallsEvent(
          structuredToolCallsByIndex,
          reasoningContent,
        );
        if (event) {
          yield event;
          sawUsableOutput = true;
        }
      }
    }

    if (options.parseDsmlToolCalls && contentBuffer.length > 0) {
      const flushed = this.flushDsmlBuffer(contentBuffer, reasoningContent);
      for (const event of flushed.events) yield event;
      sawUsableOutput ||= flushed.sawUsableOutput;
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

    // Emit normalized terminal event (Phase 4.5)
    yield { type: "terminal", stopReason };
  }

  private async fetchAndValidate(
    request: ChatRequest,
    dropTools: boolean,
  ): Promise<Response> {
    const body = this.buildRequestBody(request, !dropTools);
    const response = await this.fetchCompletion(body, request.signal);
    if (!response.ok) {
      const errorBody = await this.readResponseText(response);
      throw this.translateError(
        new Error(errorBody || `HTTP ${response.status}`),
        response,
        errorBody,
      );
    }
    return response;
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    try {
      let dropTools = false;

      const response = await withRetry(
        () => this.fetchAndValidate(request, dropTools),
        {
          ...createProviderRetryOptions({
            request,
            model: this.model,
            provider: this.name,
            retryConfig: {
              maxRetries: this.retryConfig?.maxRetries ?? 3,
              consecutive529Limit: this.retryConfig?.consecutive529Limit ?? 3,
              baseDelayMs: this.retryConfig?.baseDelayMs ?? 500,
            },
            isRetryable: (err) => this.isRetryableError(err),
            onDiagnosticEvent: (event) => this.emitDiagnostic(event),
          }),
          onFinalRetry: () => {
            dropTools = true;
          },
        },
      );

      yield* this.streamResponse(response, {
        parseDsmlToolCalls: Boolean(request.tools?.length),
        expectUsableOutput: Boolean(request.tools?.length),
        request,
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw this.translateError(error);
    }
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

  private buildUpstreamDetail(
    errorInfo: {
      message?: string;
      providerName?: string;
      retryAfterSeconds?: number;
    },
    includeRetryAfter: boolean,
  ): string | undefined {
    const details: string[] = [];
    const parts: string[] = [];
    if (typeof errorInfo.providerName === "string")
      parts.push(errorInfo.providerName);
    if (typeof errorInfo.message === "string") parts.push(errorInfo.message);
    if (parts.length > 0) details.push(parts.join(": "));
    if (includeRetryAfter && typeof errorInfo.retryAfterSeconds === "number") {
      details.push(`retry after ${errorInfo.retryAfterSeconds}s`);
    }
    return details.length > 0 ? details.join("; ") : undefined;
  }

  private buildRateLimitError(
    response: Response,
    errorInfo: {
      retryAfterSeconds?: number;
      message?: string;
      providerName?: string;
    },
    originalError: Error,
  ): ProviderRateLimitError {
    const retryAfter = response.headers?.get("retry-after");
    const retryAfterSeconds =
      errorInfo.retryAfterSeconds ?? parseRetryAfterSeconds(retryAfter);
    const detail = this.buildUpstreamDetail(errorInfo, true);
    return new ProviderRateLimitError(
      detail
        ? `OpenRouter rate limit exceeded (${detail})`
        : "OpenRouter rate limit exceeded",
      Number.isNaN(retryAfterSeconds) ? undefined : retryAfterSeconds,
      originalError,
    );
  }

  private buildUpstreamServiceError(
    type: "capacity" | "unavailable",
    errorInfo: {
      message?: string;
      providerName?: string;
      retryAfterSeconds?: number;
    },
    originalError: Error,
  ): ProviderError {
    const detail = this.buildUpstreamDetail(errorInfo, true);
    if (type === "capacity") {
      return new ProviderCapacityError(
        detail
          ? `OpenRouter upstream capacity exceeded (${detail})`
          : "OpenRouter upstream capacity exceeded",
        originalError,
      );
    }

    return new ProviderError(
      detail
        ? `OpenRouter upstream provider unavailable (${detail})`
        : "OpenRouter service error",
      originalError,
    );
  }

  private translateBasicHttpStatusError(
    response: Response,
    originalError: Error,
  ): ProviderError | null {
    switch (response.status) {
      case 401:
        return new ProviderAuthenticationError(
          "Invalid OpenRouter API key",
          originalError,
        );
      case 402:
        return new ProviderError("Insufficient OpenRouter credits", originalError);
      case 404:
        return new ProviderModelNotFoundError(
          this.model,
          `Model not found: ${this.model}`,
          originalError,
        );
      default:
        return null;
    }
  }

  private translateHttpStatusError(
    response: Response,
    errorInfo: {
      message?: string;
      providerName?: string;
      retryAfterSeconds?: number;
    },
    originalError: Error,
  ): ProviderError | null {
    if (
      response.status === 400 &&
      isContextLengthError(originalError.message)
    ) {
      return new ProviderContextLengthError(
        `Context length exceeded: ${originalError.message}`,
        originalError,
      );
    }

    const basicError = this.translateBasicHttpStatusError(response, originalError);
    if (basicError) {
      return basicError;
    }

    switch (response.status) {
      case 429:
        return this.buildRateLimitError(response, errorInfo, originalError);
      case 529:
        return this.buildUpstreamServiceError(
          "capacity",
          errorInfo,
          originalError,
        );
      case 503:
        return this.buildUpstreamServiceError(
          "unavailable",
          errorInfo,
          originalError,
        );
      default:
        return response.status >= 500
          ? new ProviderError("OpenRouter service error", originalError)
          : null;
    }
  }

  private classifyByErrorMessage(
    msg: string | undefined,
    originalError: Error,
  ): ProviderError | null {
    return this.translateCommonMessageError(
      msg,
      originalError,
      "Failed to connect to OpenRouter API",
    );
  }

  protected translateError(
    error: unknown,
    response?: Response,
    responseBody?: string,
  ): ProviderError {
    const originalError = this.createOriginalError(error);
    if (response) {
      const errorInfo = this.parseOpenRouterErrorBody(responseBody);
      const statusError = this.translateHttpStatusError(
        response,
        errorInfo,
        originalError,
      );
      if (statusError) {
        return statusError;
      }
    }

    return (
      this.classifyByErrorMessage(originalError.message, originalError) ??
      new ProviderError(
        originalError.message || "OpenRouter request failed",
        originalError,
      )
    );
  }
}
