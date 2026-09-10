import type {
  ChatMessage,
  ChatTool,
  ChatToolCall,
  LLMProvider,
} from "@propio-ai/providers";
import type {
  BuildPromptPlanOptions,
  ConversationState,
} from "../context/index.js";
import type {
  ArtifactToolResult,
  PromptBudgetPolicy,
  PromptPlan,
} from "../context/coreTypes.js";
import type { ToolExecutionContext } from "../tools/execution.js";
import type { ToolExecutionResult } from "../tools/types.js";
import type { AgentDiagnosticEvent } from "../diagnostics.js";
import type { PromptSubmission } from "./input.js";

export interface AgentExecutionPolicy {
  readonly maxIterations: number;
  readonly useNoProgressDetector: boolean;
  readonly streamIdleTimeoutMs: number;
  readonly outputTokenRecoveryLimit: number;
  /** Defaults to removing an incomplete turn on cancellation. */
  readonly discardInterruptedTurn?: (signal: AbortSignal) => boolean;
  /** Evaluated on every iteration, including final-response recovery. */
  readonly allowedTools?: () => ReadonlySet<string> | undefined;
}

export interface AgentToolExecutor {
  getEnabledSchemas(): ChatTool[];
  executeWithStatus(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

/** Optional application adapters. No default integration performs I/O. */
export interface AgentIntegrations {
  prepareTurn?(submission: PromptSubmission): void | Promise<void>;
  startTurn?(): void | Promise<void>;
  completeTurn?(): void | Promise<void>;
  /** Called only after startTurn is entered, including partially failed startup. */
  failTurn?(error: unknown): void | Promise<void>;
  instructions?(extraUserInstruction?: string): string | undefined;
  prepareMessages?(messages: ChatMessage[]): ChatMessage[];
  buildPlan?(
    extraUserInstruction?: string,
    retryLevel?: number,
    iteration?: number,
    allowedTools?: ReadonlySet<string>,
  ): PromptPlan;
  shrinkContext?(plan: PromptPlan): Promise<boolean>;
  onAssistantResponse?(content: string): void;
  onToolSuccess?(name: string, args: Record<string, unknown>): void;
  onToolBatch?(): void;
  processToolResult?(result: ArtifactToolResult): ArtifactToolResult;
}

/** Explicit conversation operations required by the runtime. */
export interface AgentContextStore {
  beginUserTurn(
    text: string,
    images?: ReadonlyArray<Uint8Array | string>,
  ): void;
  getConversationState(): ConversationState;
  getSnapshot(): ChatMessage[];
  readonly messageCount: number;
  buildPromptPlan(
    systemPrompt: string,
    extraUserInstruction?: string,
    options?: BuildPromptPlanOptions,
  ): PromptPlan;
  commitAssistantResponse(
    content: string,
    toolCalls?: ChatToolCall[],
    options?: { reasoningContent?: string },
  ): void;
  recordToolResults(results: ArtifactToolResult[]): void;
  removeLastUnresolvedAssistantMessage(): void;
  abandonIncompleteTurn(): void;
}

export interface AgentRuntimeOptions {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly context: AgentContextStore;
  readonly tools: AgentToolExecutor;
  readonly policy: AgentExecutionPolicy;
  readonly systemPrompt: string;
  readonly promptBudgetPolicy?: PromptBudgetPolicy;
  readonly integrations?: AgentIntegrations;
  readonly onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;
}
