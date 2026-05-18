import type { LLMProvider, ProviderCapabilities } from "./interface.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  ChatTool,
} from "./types.js";
import {
  ProviderError,
  ProviderAuthenticationError,
  ProviderContextLengthError,
  ProviderModelNotFoundError,
} from "./types.js";
import {
  OpenAIMessageCore,
  OpenAIToolDefinition,
  applyOpenAIMessageCore,
  createOpenAIToolDefinition,
} from "./shared.js";

export abstract class OpenAiCompatibleProvider implements LLMProvider {
  abstract readonly name: string;

  abstract getCapabilities(): ProviderCapabilities;
  abstract streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
  protected abstract translateError(
    error: unknown,
    response?: Response,
    responseBody?: string,
  ): ProviderError;

  protected chatMessageToOpenAIMessage(msg: ChatMessage): OpenAIMessageCore {
    const role = msg.role as OpenAIMessageCore["role"];
    const out: OpenAIMessageCore = { role, content: msg.content ?? "" };
    return applyOpenAIMessageCore(out, msg);
  }

  protected chatToolToOpenAITool(tool: ChatTool): OpenAIToolDefinition {
    return createOpenAIToolDefinition(tool);
  }

  protected isRetryableError(err: unknown): boolean {
    if (err instanceof ProviderAuthenticationError) return false;
    if (err instanceof ProviderContextLengthError) return false;
    if (err instanceof ProviderModelNotFoundError) return false;
    return err instanceof ProviderError;
  }
}
