import { LLMProvider, ProviderCapabilities } from "./interface.js";
import { createProviderCapabilities } from "./capabilities.js";
import { ChatRequest, ChatStreamEvent } from "./types.js";
import type { AgentDiagnosticEvent } from "../diagnostics.js";

export interface BaseProviderOptions {
  model: string;
  contextWindowTokens: number;
  retryConfig?: { maxRetries: number; consecutive529Limit: number };
  onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;
}

export abstract class BaseProvider implements LLMProvider {
  abstract readonly name: string;
  protected model: string;
  protected capabilities: ProviderCapabilities;
  protected retryConfig?: { maxRetries: number; consecutive529Limit: number };
  protected onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;

  constructor(options: BaseProviderOptions) {
    this.model = options.model;
    this.capabilities = createProviderCapabilities(options.contextWindowTokens);
    this.retryConfig = options.retryConfig;
    this.onDiagnosticEvent = options.onDiagnosticEvent;
  }

  getCapabilities(): ProviderCapabilities {
    return this.capabilities;
  }

  abstract streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}
