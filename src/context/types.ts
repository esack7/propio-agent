import { ChatMessage } from "../providers/types.js";

/**
 * Phase 1 prompt plan: behavior-preserving precursor to the richer PromptBuilder
 * planned for Phase 4. Returns the exact messages array to send plus current
 * metrics from the existing estimator.
 */
export interface PromptPlan {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly estimatedPromptTokens: number;
  readonly reservedOutputTokens: number;
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
}
