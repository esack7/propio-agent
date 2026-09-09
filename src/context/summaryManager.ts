import {
  characterTokenEstimator,
  type TokenEstimator,
  measureMessages,
} from "./tokenEstimator.js";
import type { LLMProvider, ChatRequest } from "@propio-ai/providers";
import {
  RollingSummaryRecord,
  RollingSummarySections,
  SummaryPolicy,
  DEFAULT_SUMMARY_POLICY,
  TurnRecord,
  TurnEntry,
} from "./coreTypes.js";

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
      appendAssistantSummary(lines, entry);
    } else if (entry.kind === "tool") {
      const isRecent =
        toolEntryIndex >= totalToolEntries - keepFullToolSummaries;
      appendToolSummary(lines, entry, isRecent);
      toolEntryIndex += 1;
    }
  }

  return lines.join("\n");
}

function appendAssistantSummary(
  lines: string[],
  entry: Extract<TurnEntry, { kind: "assistant" }>,
): void {
  if (entry.message.content.trim()) {
    lines.push(`Assistant: ${entry.message.content}`);
  }
  const names = entry.message.toolCalls?.map((call) => call.function.name);
  if (names?.length) lines.push(`[Called tools: ${names.join(", ")}]`);
}

function appendToolSummary(
  lines: string[],
  entry: Extract<TurnEntry, { kind: "tool" }>,
  keepFullSummary: boolean,
): void {
  for (const invocation of entry.toolInvocations) {
    const summary = keepFullSummary
      ? invocation.resultSummary
      : invocation.resultSummary.substring(0, 200);
    lines.push(`[${invocation.toolName} ${invocation.status}]: ${summary}`);
  }
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

/** A consumer may supply its own summarizer instead of a provider adapter. */
export type SummaryGenerator = (request: ChatRequest) => Promise<string>;

export interface SummaryGenerationHooks {
  readonly onRequestMeasured?: (metrics: SummaryRequestMetrics) => void;
}

function parseSummarySections(
  content: string,
): RollingSummarySections | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRollingSummarySections(parsed)
      ? (parsed as RollingSummarySections)
      : undefined;
  } catch {
    return undefined;
  }
}

async function collectSummaryContent(
  provider: Pick<LLMProvider, "streamChat"> | SummaryGenerator,
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("Summary generation cancelled");
  const content =
    typeof provider === "function"
      ? await provider({ model, messages, signal })
      : await collectProviderSummary(provider, { model, messages, signal });
  if (signal?.aborted) throw new Error("Summary generation cancelled");
  return content.trim();
}

async function collectProviderSummary(
  provider: Pick<LLMProvider, "streamChat">,
  request: ChatRequest,
): Promise<string> {
  let content = "";
  for await (const event of provider.streamChat(request)) {
    if (request.signal?.aborted)
      throw new Error("Summary generation cancelled");
    const delta =
      "type" in event
        ? event.type === "assistant_text"
          ? event.delta
          : undefined
        : event.delta;
    if (delta) content += delta;
  }
  return content.trim();
}

function buildSummaryRecord(
  content: string,
  sections: RollingSummarySections | undefined,
  eligibleTurns: ReadonlyArray<TurnRecord>,
  tokenEstimator: TokenEstimator,
): RollingSummaryRecord {
  const renderedContent = sections
    ? renderSectionsToContent(sections)
    : content;
  return {
    content: renderedContent,
    updatedAt: new Date().toISOString(),
    coveredTurnIds: eligibleTurns.map((turn) => turn.id),
    estimatedTokens: tokenEstimator.estimateText(renderedContent),
    ...(sections ? { sections } : {}),
  };
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
  constructor(
    private readonly tokenEstimator: TokenEstimator = characterTokenEstimator,
  ) {}
  /**
   * Generate an incremental rolling summary. Only the *newly eligible*
   * turns (those not already covered by `previousSummary`) are serialized
   * and sent to the model alongside the existing summary text. The
   * resulting coverage set spans all `eligibleTurns`.
   */
  async generateSummary(
    provider: Pick<LLMProvider, "streamChat"> | SummaryGenerator,
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

    const userPrompt = buildSummarizationUserPrompt(
      previousSummary?.content,
      newTurns.map(serializeTurnForSummary),
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
      estimatedPromptTokens: this.tokenEstimator.estimateMessages(messages),
    });

    const content = await collectSummaryContent(
      provider,
      model,
      messages,
      signal,
    );
    const summary = buildSummaryRecord(
      content,
      parseSummarySections(content),
      eligibleTurns,
      this.tokenEstimator,
    );

    return {
      summary,
      refreshedTurnCount: newTurns.length,
    };
  }
}

export { serializeTurnForSummary, SUMMARY_SYSTEM_PROMPT };
