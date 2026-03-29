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
 * A single assistant or tool entry within a turn.
 *
 * One user turn can contain multiple assistant/tool iterations before the
 * final answer (e.g. multi-step tool loops). Each iteration is a separate
 * entry rather than being collapsed into a single assistant message.
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
 * Phase 2 stores the turn array plus any messages recorded before the
 * first turn; later phases add session metadata, pinned context, rolling
 * summaries, and artifacts.
 *
 * `preamble` holds messages that were committed without a preceding
 * beginUserTurn().  In normal Agent usage this array is empty, but it
 * ensures the structured view is full-fidelity: getSnapshot() and
 * getConversationState() always represent the same logical content.
 */
export interface ConversationState {
  readonly preamble: ReadonlyArray<ChatMessage>;
  readonly turns: ReadonlyArray<TurnRecord>;
}
