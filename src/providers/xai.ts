import { ProviderCapabilities } from "./interface.js";
import {
  ChatRequest,
  ChatStreamEvent,
  ProviderError,
  ProviderAuthenticationError,
  ProviderModelNotFoundError,
  ProviderCapacityError,
} from "./types.js";
import type { AgentDiagnosticEvent } from "../diagnostics.js";
import { withRetry } from "./withRetry.js";
import {
  accumulateOpenAIStreamToolCall,
  buildOpenAIChatCompletionRequestBody,
  buildOpenAIStreamToolCalls,
  parseJsonMaybe,
  parseOpenAIStreamToolCallArguments,
  readSseDataLines,
} from "./shared.js";
import {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleProviderOptions,
} from "./openAiCompatibleProvider.js";

const XAI_API_URLS = [
  "https://api.x.ai/v1/chat/completions",
  "https://us-east-1.api.x.ai/v1/chat/completions",
  "https://eu-west-1.api.x.ai/v1/chat/completions",
] as const;

/**
 * xAI (Grok) implementation of LLMProvider using the OpenAI-compatible API at api.x.ai.
 */
export class XaiProvider extends OpenAiCompatibleProvider {
  readonly name = "xai";
  private readonly model: string;
  private readonly apiKey: string;
  private readonly retryConfig?: {
    maxRetries: number;
    consecutive529Limit: number;
  };
  private readonly onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;

  private static readonly CONTEXT_WINDOWS: Record<string, number> = {
    "grok-4.20-0309-reasoning": 2_000_000,
    "grok-4.20-0309-non-reasoning": 2_000_000,
    "grok-4.20-multi-agent-0309": 2_000_000,
    "grok-4-1-fast-reasoning": 2_000_000,
    "grok-4-1-fast-non-reasoning": 2_000_000,
  };

  private static readonly DEFAULT_CONTEXT_WINDOW = 2_000_000;

  constructor(options: OpenAiCompatibleProviderOptions) {
    super();
    const apiKey = options.apiKey ?? process.env.XAI_API_KEY ?? "";
    if (!apiKey || apiKey.trim() === "") {
      throw new ProviderAuthenticationError(
        "xAI API key is required. Set XAI_API_KEY or pass apiKey in options.",
      );
    }
    this.retryConfig = options.retryConfig;
    this.onDiagnosticEvent = options.onDiagnosticEvent;
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

  private shouldRetryEndpoint(status?: number): boolean {
    return status !== undefined && status >= 500 && status < 600;
  }

  private isAbortError(translated: ProviderError): boolean {
    return (
      translated.message === "Request cancelled" ||
      translated.originalError?.name === "AbortError"
    );
  }

  private shouldContinueToNextEndpoint(
    error: unknown,
    translated: ProviderError,
  ): boolean {
    return !(error instanceof ProviderError) && !this.isAbortError(translated);
  }

  private async createEndpointResponseError(response: Response): Promise<{
    translated: ProviderError;
    retryable: boolean;
  }> {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch {
      // ignore read failures
    }

    return {
      translated: this.translateError(
        new Error(errorBody || `HTTP ${response.status}`),
        response,
      ),
      retryable: this.shouldRetryEndpoint(response.status),
    };
  }

  private getContinuationError(error: unknown): ProviderError {
    const translated =
      error instanceof ProviderError ? error : this.translateError(error);
    if (!this.shouldContinueToNextEndpoint(error, translated)) {
      throw translated;
    }
    return translated;
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

        const { translated, retryable } =
          await this.createEndpointResponseError(response);
        if (!retryable) {
          throw translated;
        }
        lastError = translated;
      } catch (error) {
        lastError = this.getContinuationError(error);
      }
    }

    throw lastError ?? new ProviderError("xAI request failed");
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    try {
      const body = this.createChatCompletionRequestBody(request);
      const response = await withRetry(
        () => this.createChatCompletionResponse(body, request.signal),
        this.buildRetryOptions(
          request,
          this.model,
          this.retryConfig,
          this.onDiagnosticEvent,
        ),
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
    let finishReason: any = "end_turn";

    for await (const data of readSseDataLines(reader)) {
      const result = this.parseStreamLine(data, toolCallsByIndex);
      if (result.stopReason) {
        finishReason = result.stopReason;
      }
      for (const event of result.events) {
        yield event;
      }
    }

    // Emit normalized terminal event (Phase 4.5)
    yield { type: "terminal", stopReason: finishReason };
  }

  private mapXaiFinishReason(finishReason: string): string {
    const finishReasonMap: Record<string, string> = {
      length: "max_tokens",
      stop: "end_turn",
      tool_calls: "tool_use",
    };
    return finishReasonMap[finishReason] ?? "end_turn";
  }

  private buildToolCallsFromFinishReason(
    finishReason: string | undefined,
    toolCallsByIndex: Map<number, AccumulatedToolCall>,
  ): ChatStreamEvent | null {
    if (finishReason !== "tool_calls") {
      return null;
    }

    const toolCalls = buildOpenAIStreamToolCalls(toolCallsByIndex, (acc) => ({
      id: acc.id,
      function: {
        name: acc.name || "",
        arguments: parseOpenAIStreamToolCallArguments(acc.argsString),
      },
    }));
    return toolCalls.length > 0 ? { type: "tool_calls", toolCalls } : null;
  }

  private parseXaiStreamChoice(data: string):
    | {
        delta?: {
          content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string;
      }
    | undefined {
    return parseJsonMaybe<{
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
    }>(data)?.choices?.[0];
  }

  private appendXaiContentEvent(
    content: string | undefined,
    events: ChatStreamEvent[],
  ): void {
    if (content != null && content !== "") {
      events.push({ type: "assistant_text", delta: content });
    }
  }

  private accumulateXaiToolCalls(
    toolCalls:
      | Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>
      | undefined,
    toolCallsByIndex: Map<number, AccumulatedToolCall>,
  ): void {
    if (!toolCalls || !Array.isArray(toolCalls)) {
      return;
    }

    for (const toolCall of toolCalls) {
      accumulateOpenAIStreamToolCall(toolCall, toolCallsByIndex, () => ({
        name: "",
        argsString: "",
      }));
    }
  }

  private parseStreamLine(
    data: string,
    toolCallsByIndex: Map<number, AccumulatedToolCall>,
  ): { events: ChatStreamEvent[]; stopReason?: string } {
    if (data === "[DONE]") {
      return { events: [] };
    }

    const choice = this.parseXaiStreamChoice(data);
    if (!choice?.delta) {
      return { events: [] };
    }

    const events: ChatStreamEvent[] = [];
    this.appendXaiContentEvent(choice.delta.content, events);
    this.accumulateXaiToolCalls(choice.delta.tool_calls, toolCallsByIndex);

    const toolCallsEvent = this.buildToolCallsFromFinishReason(
      choice.finish_reason,
      toolCallsByIndex,
    );
    if (toolCallsEvent) {
      events.push(toolCallsEvent);
    }

    return {
      events,
      stopReason: choice.finish_reason
        ? this.mapXaiFinishReason(choice.finish_reason)
        : undefined,
    };
  }

  protected translateError(
    error: unknown,
    response?: Response,
    _responseBody?: string,
  ): ProviderError {
    return this.translateStandardOpenAiError(error, response, {
      model: this.model,
      authenticationMessage: "Invalid xAI API key",
      rateLimitMessage: "xAI rate limit exceeded",
      serviceErrorMessage: "xAI service error",
      connectionErrorMessage: "Failed to connect to xAI API",
      requestFailedMessage: "xAI request failed",
    });
  }
}

interface AccumulatedToolCall {
  id?: string;
  name: string;
  argsString: string;
}
