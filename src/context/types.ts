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
