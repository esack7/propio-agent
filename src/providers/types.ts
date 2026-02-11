/**
 * Tool result representation
 */
export interface ToolResult {
  toolCallId: string; // Provider-specific tool call ID
  toolName: string; // Name of the tool that was called
  content: string;
}

/**
 * Provider-agnostic message type
 */
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string; // For tool role messages: which tool call this is a result for (deprecated, use toolResults)
  toolResults?: ToolResult[]; // For batched tool results
  images?: (Uint8Array | string)[];
}

/**
 * Tool call representation
 */
export interface ChatToolCall {
  id?: string; // Provider-specific tool call ID (e.g., Bedrock toolUseId)
  function: {
    name: string;
    arguments: Record<string, any>;
  };
}

/**
 * Tool definition
 */
export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

/**
 * Chat request with all information needed for LLM request
 */
export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  tools?: ChatTool[];
  stream?: boolean;
}

/**
 * Chat response from provider
 */
export interface ChatResponse {
  message: ChatMessage;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
}

/**
 * Streaming chat chunk
 */
export interface ChatChunk {
  delta: string;
  toolCalls?: ChatToolCall[];
}

/**
 * Base provider error class
 */
export class ProviderError extends Error {
  public originalError?: Error;

  constructor(message: string, originalError?: Error) {
    super(message);
    this.name = "ProviderError";
    this.originalError = originalError;
  }
}

/**
 * Authentication error
 */
export class ProviderAuthenticationError extends ProviderError {
  constructor(message: string, originalError?: Error) {
    super(message, originalError);
    this.name = "ProviderAuthenticationError";
  }
}

/**
 * Rate limit error with optional retry info
 */
export class ProviderRateLimitError extends ProviderError {
  public retryAfterSeconds?: number;

  constructor(
    message: string,
    retryAfterSeconds?: number,
    originalError?: Error,
  ) {
    super(message, originalError);
    this.name = "ProviderRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Model not found error
 */
export class ProviderModelNotFoundError extends ProviderError {
  public modelName: string;

  constructor(modelName: string, message: string, originalError?: Error) {
    super(message, originalError);
    this.name = "ProviderModelNotFoundError";
    this.modelName = modelName;
  }
}
