import { estimateTokens } from "../diagnostics.js";
import { LLMProvider } from "../providers/interface.js";
import {
  RollingSummaryRecord,
  SummaryPolicy,
  DEFAULT_SUMMARY_POLICY,
  TurnRecord,
  TurnEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Summarization prompt template
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = `You are a session summarizer. Produce a concise summary that preserves:
- User goals and open questions
- Constraints and explicit instructions from the user
- Key decisions made and their rationale
- Important facts about the environment, project, or domain
- What was accomplished and what remains

Omit stylistic filler, greetings, and transient observations. Keep the summary factual and compact.`;

function buildSummarizationUserPrompt(
  previousSummary: string | undefined,
  turnTexts: string[],
  targetTokens: number,
): string {
  const parts: string[] = [];

  if (previousSummary) {
    parts.push(`<previous_summary>\n${previousSummary}\n</previous_summary>`);
  }

  parts.push(`<new_turns>\n${turnTexts.join("\n---\n")}\n</new_turns>`);

  parts.push(
    `Produce an updated session summary incorporating the previous summary (if any) and the new turns. Target roughly ${targetTokens} tokens. Output only the summary text with no wrapper tags.`,
  );

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Turn serialization (summaries only — never raw artifact bodies)
// ---------------------------------------------------------------------------

function serializeTurnForSummary(turn: TurnRecord): string {
  const lines: string[] = [];
  lines.push(`User: ${turn.userMessage.content}`);

  for (const entry of turn.entries) {
    if (entry.kind === "assistant") {
      if (entry.message.content.trim()) {
        lines.push(`Assistant: ${entry.message.content}`);
      }
      if (entry.message.toolCalls && entry.message.toolCalls.length > 0) {
        const names = entry.message.toolCalls.map((tc) => tc.function.name);
        lines.push(`[Called tools: ${names.join(", ")}]`);
      }
    } else if (entry.kind === "tool") {
      const toolEntry = entry as TurnEntry & { kind: "tool" };
      for (const inv of toolEntry.toolInvocations) {
        lines.push(
          `[${inv.toolName} ${inv.status}]: ${inv.resultSummary.substring(0, 500)}`,
        );
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Eligibility helpers
// ---------------------------------------------------------------------------

export interface SummaryEligibility {
  readonly eligibleTurns: ReadonlyArray<TurnRecord>;
  readonly newEligibleCount: number;
  readonly shouldRefresh: boolean;
  readonly reason?: "turn_cadence" | "context_pressure";
}

/**
 * Determine which completed turns are eligible for summarization and
 * whether a refresh is warranted based on the current policy.
 */
export function computeSummaryEligibility(
  completedTurns: ReadonlyArray<TurnRecord>,
  currentSummary: RollingSummaryRecord | undefined,
  policy: SummaryPolicy,
  estimatedPromptTokens?: number,
  availableInputBudget?: number,
): SummaryEligibility {
  if (completedTurns.length <= policy.rawRecentTurns) {
    return { eligibleTurns: [], newEligibleCount: 0, shouldRefresh: false };
  }

  const eligibleTurns = completedTurns.slice(
    0,
    completedTurns.length - policy.rawRecentTurns,
  );

  const coveredSet = new Set(currentSummary?.coveredTurnIds ?? []);
  const newEligible = eligibleTurns.filter((t) => !coveredSet.has(t.id));
  const newEligibleCount = newEligible.length;

  if (newEligibleCount >= policy.refreshIntervalTurns) {
    return {
      eligibleTurns,
      newEligibleCount,
      shouldRefresh: true,
      reason: "turn_cadence",
    };
  }

  if (
    estimatedPromptTokens != null &&
    availableInputBudget != null &&
    availableInputBudget > 0
  ) {
    const pressure = estimatedPromptTokens / availableInputBudget;
    if (pressure >= policy.contextPressureThreshold && newEligibleCount > 0) {
      return {
        eligibleTurns,
        newEligibleCount,
        shouldRefresh: true,
        reason: "context_pressure",
      };
    }
  }

  return { eligibleTurns, newEligibleCount, shouldRefresh: false };
}

// ---------------------------------------------------------------------------
// SummaryManager
// ---------------------------------------------------------------------------

export interface SummaryRefreshResult {
  readonly summary: RollingSummaryRecord;
  readonly refreshedTurnCount: number;
}

/**
 * Generates rolling summaries using an LLM provider. Summaries are built
 * incrementally: the previous summary is combined with newly eligible turns
 * and condensed into a single updated summary.
 *
 * The manager is stateless — it receives inputs and returns results. State
 * storage and scheduling live in ContextManager and Agent respectively.
 */
export class SummaryManager {
  /**
   * Generate an incremental rolling summary. Only the *newly eligible*
   * turns (those not already covered by `previousSummary`) are serialized
   * and sent to the model alongside the existing summary text. The
   * resulting coverage set spans all `eligibleTurns`.
   */
  async generateSummary(
    provider: LLMProvider,
    model: string,
    eligibleTurns: ReadonlyArray<TurnRecord>,
    previousSummary: RollingSummaryRecord | undefined,
    policy: SummaryPolicy,
    signal?: AbortSignal,
  ): Promise<SummaryRefreshResult> {
    const coveredSet = new Set(previousSummary?.coveredTurnIds ?? []);
    const newTurns = eligibleTurns.filter((t) => !coveredSet.has(t.id));

    if (newTurns.length === 0 && previousSummary) {
      return {
        summary: {
          ...previousSummary,
          coveredTurnIds: eligibleTurns.map((t) => t.id),
        },
        refreshedTurnCount: 0,
      };
    }

    const turnTexts = newTurns.map(serializeTurnForSummary);

    const userPrompt = buildSummarizationUserPrompt(
      previousSummary?.content,
      turnTexts,
      policy.summaryTargetTokens,
    );

    let content = "";
    for await (const event of provider.streamChat({
      model,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      signal,
    })) {
      if (signal?.aborted) {
        throw new Error("Summary generation cancelled");
      }
      const delta =
        "type" in event
          ? event.type === "assistant_text"
            ? event.delta
            : undefined
          : event.delta;
      if (delta) {
        content += delta;
      }
    }

    const summary: RollingSummaryRecord = {
      content: content.trim(),
      updatedAt: new Date().toISOString(),
      coveredTurnIds: eligibleTurns.map((t) => t.id),
      estimatedTokens: estimateTokens(content.trim().length),
    };

    return {
      summary,
      refreshedTurnCount: newTurns.length,
    };
  }
}

export { serializeTurnForSummary, SUMMARY_SYSTEM_PROMPT };
