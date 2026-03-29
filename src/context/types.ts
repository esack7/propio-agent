import { ChatMessage } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Pinned Memory (Phase 7)
// ---------------------------------------------------------------------------

export type MemoryKind = "fact" | "constraint" | "decision";
export type MemoryScope = "session" | "project";
export type MemoryLifecycle = "active" | "superseded" | "removed";
export type MemoryOrigin = "user" | "assistant" | "tool" | "application";

export interface MemorySource {
  readonly origin: MemoryOrigin;
  readonly turnId?: string;
  readonly toolCallId?: string;
}

export interface PinnedMemoryRecord {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
  readonly content: string;
  readonly source: MemorySource;
  readonly rationale?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lifecycle: MemoryLifecycle;
  readonly supersededById?: string;
}

export interface PinFactInput {
  readonly kind: MemoryKind;
  readonly scope?: MemoryScope;
  readonly content: string;
  readonly source: MemorySource;
  readonly rationale?: string;
}

export interface UpdateMemoryInput {
  readonly content?: string;
  readonly rationale?: string;
}

// ---------------------------------------------------------------------------
// Budget and summary policies
// ---------------------------------------------------------------------------

/**
 * Configurable budget policy for prompt assembly. Controls how much of the
 * context window is available for prompt content vs. reserved for output,
 * and sets caps on turn/artifact inclusion.
 */
export interface PromptBudgetPolicy {
  readonly reservedOutputTokens: number;
  readonly maxRecentTurns: number;
  readonly artifactInlineCharCap: number;
  readonly contextWindowOverrideTokens?: number;
}

export const DEFAULT_BUDGET_POLICY: PromptBudgetPolicy = {
  reservedOutputTokens: 2048,
  maxRecentTurns: 50,
  artifactInlineCharCap: 12000,
};

/**
 * Policy controlling when and how rolling summaries are generated.
 *
 * `rawRecentTurns` — the number of newest completed turns that are always
 * included verbatim in the prompt (the "protected" recent window).
 *
 * `refreshIntervalTurns` — after this many newly eligible turns accumulate
 * beyond the current summary coverage, a summary refresh is triggered.
 *
 * `summaryTargetTokens` — soft cap on generated summary length; included
 * as guidance in the summarization prompt.
 *
 * `contextPressureThreshold` — fraction of the available input budget.
 * When estimated prompt tokens exceed this ratio, a summary refresh is
 * triggered regardless of the turn-count cadence.
 */
export interface SummaryPolicy {
  readonly rawRecentTurns: number;
  readonly refreshIntervalTurns: number;
  readonly summaryTargetTokens: number;
  readonly contextPressureThreshold: number;
}

export const DEFAULT_SUMMARY_POLICY: SummaryPolicy = {
  rawRecentTurns: 6,
  refreshIntervalTurns: 3,
  summaryTargetTokens: 512,
  contextPressureThreshold: 0.6,
};

/**
 * Persistent record of the rolling summary that compacts older turns
 * into a concise narrative for long-session continuity.
 */
export interface RollingSummaryRecord {
  readonly content: string;
  readonly updatedAt: string;
  readonly coveredTurnIds: ReadonlyArray<string>;
  readonly estimatedTokens: number;
}

/**
 * Prompt plan produced by the PromptBuilder. Contains the messages to send
 * plus diagnostic metadata describing what was included, what was omitted,
 * and at what retry level the plan was built.
 *
 * retryLevel semantics:
 *   0 = initial build (full budget)
 *   1 = fewer historical turns
 *   2 = tighter artifact/raw-content caps
 *   3 = minimal prompt (system + current user + unresolved tool chain)
 */
export interface PromptPlan {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly estimatedPromptTokens: number;
  readonly reservedOutputTokens: number;
  readonly includedTurnIds: ReadonlyArray<string>;
  readonly includedArtifactIds: ReadonlyArray<string>;
  readonly omittedTurnIds: ReadonlyArray<string>;
  readonly usedRollingSummary: boolean;
  readonly retryLevel: number;
}

/**
 * Structured record of a single tool invocation within a turn.
 * Replaces the opaque ChatMessage.toolResults content with explicit
 * metadata, summary, and a reference to the full artifact.
 */
export interface ToolInvocationRecord {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: "success" | "error";
  readonly resultSummary: string;
  readonly artifactId: string;
  readonly mediaType: string;
  readonly contentSizeChars: number;
  readonly estimatedTokens?: number;
}

/**
 * A stored artifact containing the full raw content of a tool result
 * or other bulky payload. Artifacts are referenced by turn entries and
 * live in memory for the duration of the session.
 */
export interface ArtifactRecord {
  readonly id: string;
  readonly type:
    | "tool_result"
    | "file_snapshot"
    | "command_output"
    | "image"
    | "pdf"
    | "other";
  readonly mediaType: string;
  readonly createdAt: string;
  readonly content: string | Uint8Array;
  readonly contentSizeChars: number;
  readonly estimatedTokens?: number;
  readonly referencingTurnIds: ReadonlyArray<string>;
}

/**
 * Input type for recording tool results with full raw content.
 * The ContextManager creates artifacts and summaries from these inputs.
 *
 * `rawContent` accepts both text and binary data. When binary data is
 * provided, callers should set `mediaType` to describe the content
 * (e.g. "image/png"). When omitted, `mediaType` defaults to
 * "text/plain" for string content and "application/octet-stream" for
 * Uint8Array content.
 */
export interface ArtifactToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly rawContent: string | Uint8Array;
  readonly mediaType?: string;
  readonly status: "success" | "error";
}

/**
 * A single assistant or tool entry within a turn.
 *
 * One user turn can contain multiple assistant/tool iterations before the
 * final answer (e.g. multi-step tool loops). Each iteration is a separate
 * entry rather than being collapsed into a single assistant message.
 *
 * Tool entries carry ToolInvocationRecord metadata alongside the ChatMessage.
 * The ChatMessage holds summary content; full raw content lives in artifacts.
 */
export type TurnEntry =
  | {
      readonly kind: "assistant";
      readonly createdAt: string;
      readonly estimatedTokens?: number;
      readonly message: ChatMessage;
    }
  | {
      readonly kind: "tool";
      readonly createdAt: string;
      readonly estimatedTokens?: number;
      readonly message: ChatMessage;
      readonly toolInvocations: ReadonlyArray<ToolInvocationRecord>;
    };

/**
 * A single conversational turn anchored by one user message and containing
 * all assistant/tool iterations that follow before the next user message.
 */
export interface TurnRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly importance: "low" | "normal" | "high";
  readonly summary?: string;
  readonly estimatedTokens?: number;
  readonly userMessage: ChatMessage;
  readonly entries: ReadonlyArray<TurnEntry>;
}

/**
 * Top-level structured conversation state.
 *
 * `preamble` holds messages that were committed without a preceding
 * beginUserTurn().  In normal Agent usage this array is empty, but it
 * ensures the structured view is full-fidelity: getSnapshot() and
 * getConversationState() always represent the same logical content.
 *
 * `artifacts` contains full raw tool-result payloads, referenced by
 * ToolInvocationRecord.artifactId on turn entries.
 */
export interface ConversationState {
  readonly preamble: ReadonlyArray<ChatMessage>;
  readonly turns: ReadonlyArray<TurnRecord>;
  readonly artifacts: ReadonlyArray<ArtifactRecord>;
  readonly rollingSummary?: RollingSummaryRecord;
  readonly pinnedMemory: ReadonlyArray<PinnedMemoryRecord>;
}
