import { ChatRequest, ChatResponse, ChatChunk } from "./types";

/**
 * LLMProvider interface defining the contract for all LLM provider implementations
 */
export interface LLMProvider {
  /**
   * Provider identifier
   */
  readonly name: string;

  /**
   * Non-streaming chat completion
   * @param request - The chat request with messages, model, and optional tools
   * @returns Promise resolving to ChatResponse with message and stop reason
   */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /**
   * Streaming chat completion
   * @param request - The chat request with messages, model, and optional tools
   * @returns AsyncIterable yielding ChatChunk objects for each token/chunk of the response
   */
  streamChat(request: ChatRequest): AsyncIterable<ChatChunk>;
}
