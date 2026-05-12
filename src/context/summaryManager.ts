import { estimateTokens, measureMessages } from "../diagnostics.js";
import { LLMProvider } from "../providers/interface.js";
import {
  RollingSummaryRecord,
  RollingSummarySections,
  SummaryPolicy,
  DEFAULT_SUMMARY_POLICY,
  TurnRecord,
  TurnEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Summarization prompt template
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = `You are a session summarizer. Respond with a JSON object with the following optional keys (omit any key that has no relevant content):

{
  "goals":        "Current user objectives and open questions.",
  "constraints":  "Explicit instructions or limits from the user.",
  "decisions":    "Key decisions made and their rationale.",
  "facts":        "Important facts about the environment, project, or domain.",
  "accomplished": "What has been completed in this session.",
  "remaining":    "What still needs to be done.",
  "narrative":    "Anything that does not fit the above sections."
}

Output only the JSON object—no wrapper text, no Markdown code fences.
Keep each value concise and factual; omit greetings, filler, and transient observations.`;

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
    `Produce an updated session summary as a JSON object using the schema in the system prompt. Incorporate the previous summary (if any) and the new turns. Target roughly ${targetTokens} tokens total across all sections. Output only the JSON object.`,
  );

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Turn serialization (summaries only — never raw artifact bodies)
// ---------------------------------------------------------------------------

function serializeTurnForSummary(
  turn: TurnRecord,
  keepFullToolSummaries: number = 5,
): string {
  const lines: string[] = [];
  lines.push(`User: ${turn.userMessage.content}`);

  // Count total tool entries for selective preservation
  const totalToolEntries = turn.entries.filter((e) => e.kind === "tool").length;
  let toolEntryIndex = 0;

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
      const isRecent =
        toolEntryIndex >= totalToolEntries - keepFullToolSummaries;
      const clipLimit = isRecent ? Infinity : 200;
      const toolEntry = entry as TurnEntry & { kind: "tool" };
      for (const inv of toolEntry.toolInvocations) {
        const summary =
          clipLimit === Infinity
            ? inv.resultSummary
            : inv.resultSummary.substring(0, clipLimit);
        lines.push(`[${inv.toolName} ${inv.status}]: ${summary}`);
      }
      toolEntryIndex++;
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
// Structured summary parsing and rendering
// ---------------------------------------------------------------------------

const VALID_SECTION_KEYS = new Set<string>([
  "narrative",
  "goals",
  "constraints",
  "decisions",
  "facts",
  "accomplished",
  "remaining",
]);

function isRollingSummarySections(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  return keys.every(
    (k) => VALID_SECTION_KEYS.has(k) && typeof obj[k] === "string",
  );
}

function renderSectionsToContent(sections: RollingSummarySections): string {
  const SECTION_LABELS: Array<[keyof RollingSummarySections, string]> = [
    ["goals", "Goals"],
    ["constraints", "Constraints"],
    ["decisions", "Decisions"],
    ["facts", "Facts"],
    ["accomplished", "Accomplished"],
    ["remaining", "Remaining"],
    ["narrative", "Notes"],
  ];
  return SECTION_LABELS.filter(([key]) => sections[key] !== undefined)
    .map(([key, label]) => `${label}: ${sections[key]}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// SummaryManager
// ---------------------------------------------------------------------------

export interface SummaryRefreshResult {
  readonly summary: RollingSummaryRecord;
  readonly refreshedTurnCount: number;
}

export interface SummaryRequestMetrics {
  readonly promptMessageCount: number;
  readonly promptChars: number;
  readonly estimatedPromptTokens: number;
}

export interface SummaryGenerationHooks {
  readonly onRequestMeasured?: (metrics: SummaryRequestMetrics) => void;
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
    hooks?: SummaryGenerationHooks,
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

    const messages = [
      { role: "system" as const, content: SUMMARY_SYSTEM_PROMPT },
      { role: "user" as const, content: userPrompt },
    ];
    const requestMetrics = measureMessages(messages);
    hooks?.onRequestMeasured?.({
      promptMessageCount: requestMetrics.messageCount,
      promptChars: requestMetrics.totalChars,
      estimatedPromptTokens: requestMetrics.estimatedTokens,
    });

    let content = "";
    for await (const event of provider.streamChat({
      model,
      messages,
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

    const trimmed = content.trim();
    let sections: RollingSummarySections | undefined;

    try {
      const parsed: unknown = JSON.parse(trimmed);
      sections = isRollingSummarySections(parsed)
        ? (parsed as RollingSummarySections)
        : undefined;
    } catch {
      sections = undefined;
    }

    const renderedContent = sections
      ? renderSectionsToContent(sections)
      : trimmed;

    const summary: RollingSummaryRecord = {
      content: renderedContent,
      updatedAt: new Date().toISOString(),
      coveredTurnIds: eligibleTurns.map((t) => t.id),
      estimatedTokens: estimateTokens(renderedContent.length),
      ...(sections !== undefined ? { sections } : {}),
    };

    return {
      summary,
      refreshedTurnCount: newTurns.length,
    };
  }
}

export { serializeTurnForSummary, SUMMARY_SYSTEM_PROMPT };
