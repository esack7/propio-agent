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
import type { AgentTraceRecorder } from "../trace/types.js";

export interface AgentExecutionPolicy {
  readonly maxIterations: number;
  readonly useNoProgressDetector: boolean;
  readonly streamIdleTimeoutMs: number;
  readonly outputTokenRecoveryLimit: number;
  /** Defaults to removing an incomplete turn on cancellation. */
  readonly discardInterruptedTurn?: (signal: AbortSignal) => boolean;
  /** Evaluated on every iteration, including final-response recovery. */
  readonly allowedTools?: () => ReadonlySet<string> | undefined;
  /** Preferred revisioned tool scope. When supplied, it supersedes allowedTools. */
  readonly resolveToolScope?: () => AgentToolScope;
}

export interface AgentToolScope {
  readonly allowedTools?: ReadonlySet<string>;
  readonly policyRevisionId?: string;
  readonly toolScopeRevisionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentToolAuthorizationRequest {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** The exact scope selected before the provider request was dispatched. */
  readonly scope: AgentToolScope;
  readonly signal?: AbortSignal;
}

export interface AgentToolPolicyDecision {
  readonly allowed: boolean;
  readonly actor: "agent" | "application" | "user";
  readonly rule: string;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentPromptInstructionRevision {
  readonly source: string;
  readonly scope: string;
  readonly revisionId: string;
}

export interface AgentPromptOmission {
  readonly kind: "turn" | "artifact";
  readonly id: string;
  readonly reason: string;
  /** Stable classification for artifact omissions; free-text reason is descriptive only. */
  readonly reasonCode?: "artifact_pruned" | "artifact_omitted";
}

/** Optional application-owned lineage for a prompt plan. */
export interface AgentPromptTraceMetadata {
  readonly summaryRevisionId?: string;
  readonly instructionRevisions?: ReadonlyArray<AgentPromptInstructionRevision>;
  readonly omissions?: ReadonlyArray<AgentPromptOmission>;
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
  describePromptPlan?(plan: PromptPlan): AgentPromptTraceMetadata;
  /** Application policy evaluated against a detached argument snapshot. */
  authorizeTool?(
    request: AgentToolAuthorizationRequest,
  ): AgentToolPolicyDecision | Promise<AgentToolPolicyDecision>;
  shrinkContext?(plan: PromptPlan): Promise<boolean>;
  onAssistantResponse?(content: string): void;
  onToolSuccess?(name: string, args: Record<string, unknown>): void;
  onToolBatch?(): void;
  processToolResult?(result: ArtifactToolResult): ArtifactToolResult;
  /** Called after the result is in context, before the next tool is dispatched. */
  onToolResultCommitted?(result: ArtifactToolResult): void;
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
  /** Optional caller-owned trace recorder. The runtime performs no storage discovery. */
  readonly trace?: AgentTraceRecorder;
}
