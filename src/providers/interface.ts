import { ChatRequest, ChatStreamEvent } from "./types.js";

/**
 * LLMProvider interface defining the contract for all LLM provider implementations
 */
export interface LLMProvider {
  /**
   * Provider identifier
   */
  readonly name: string;

  /**
   * Streaming chat completion
   * @param request - The chat request with messages, model, and optional tools
   * @returns AsyncIterable yielding ChatStreamEvent objects for assistant text/tool calls/status updates
   */
  streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}
