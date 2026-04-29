import { ChatMessage } from "../providers/types.js";
import { estimateTokens, measureMessages } from "../diagnostics.js";
import {
  PromptPlan,
  PromptBudgetPolicy,
  DEFAULT_BUDGET_POLICY,
  ConversationState,
  TurnRecord,
  TurnEntry,
  ArtifactRecord,
  RollingSummaryRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Build request: everything the builder needs to produce a plan
// ---------------------------------------------------------------------------

export interface PromptBuildRequest {
  readonly systemPrompt: string;
  /** Pre-rendered pinned memory block (from memoryManager.renderPinnedMemoryBlock). */
  readonly pinnedMemoryBlock?: string;
  /** Pre-rendered invoked skill block. */
  readonly invokedSkillsBlock?: string;
  readonly conversationState: ConversationState;
  readonly contextWindowTokens: number;
  readonly policy: PromptBudgetPolicy;
  readonly extraUserInstruction?: string;
  readonly rollingSummary?: string;
  /** Turn IDs already covered by the rolling summary. These are excluded
   *  from raw history inclusion when a summary is available. */
  readonly summaryCoveredTurnIds?: ReadonlySet<string>;
  readonly retryLevel?: number;
  readonly artifactLookup: (id: string) => ArtifactRecord | undefined;
  readonly isCurrentTurnUnresolved: (turnId: string) => boolean;
}

// ---------------------------------------------------------------------------
// Rehydration cap (matches ContextManager constant)
// ---------------------------------------------------------------------------

const REHYDRATION_MAX_CHARS = 12000;

// Approximate overhead of the <session_summary> wrapper tags + newlines
const SESSION_SUMMARY_WRAPPER_OVERHEAD = 40;

function capForRehydration(rawContent: string): string {
  if (rawContent.length <= REHYDRATION_MAX_CHARS) {
    return rawContent;
  }
  const truncated = rawContent.substring(0, REHYDRATION_MAX_CHARS);
  const omitted = rawContent.length - REHYDRATION_MAX_CHARS;
  return `${truncated}\n\n[output truncated: ${omitted} chars omitted]`;
}

// ---------------------------------------------------------------------------
// Retry-level budgets
// ---------------------------------------------------------------------------

interface RetryLevelConfig {
  maxRecentTurnsFraction: number;
  artifactCapFraction: number;
}

const RETRY_LEVELS: RetryLevelConfig[] = [
  { maxRecentTurnsFraction: 1.0, artifactCapFraction: 1.0 },
  { maxRecentTurnsFraction: 0.5, artifactCapFraction: 1.0 },
  { maxRecentTurnsFraction: 0.25, artifactCapFraction: 0.5 },
  { maxRecentTurnsFraction: 0, artifactCapFraction: 0 },
];

// ---------------------------------------------------------------------------
// PromptBuilder
// ---------------------------------------------------------------------------

export class PromptBuilder {
  /**
   * Compose the base system prompt with pinned memory appended. The
   * pinned memory block is placed after the system prompt and before
   * any rolling summary, giving it a stable position for cacheability.
   */
  private composeSystemBase(request: PromptBuildRequest): string {
    const blocks: string[] = [request.systemPrompt];
    if (request.pinnedMemoryBlock) {
      blocks.push(request.pinnedMemoryBlock);
    }
    if (request.invokedSkillsBlock) {
      blocks.push(request.invokedSkillsBlock);
    }
    return blocks.join("\n\n");
  }

  buildPlan(request: PromptBuildRequest): PromptPlan {
    const level = Math.min(request.retryLevel ?? 0, 3);

    if (level >= 3) {
      return this.buildMinimalPlan(request);
    }

    return this.buildNormalPlan(request, level);
  }

  // -----------------------------------------------------------------------
  // Normal build (retry levels 0–2)
  // -----------------------------------------------------------------------

  private buildNormalPlan(
    request: PromptBuildRequest,
    level: number,
  ): PromptPlan {
    const policy = request.policy;
    const retryConfig = RETRY_LEVELS[level];

    const inputBudget =
      request.contextWindowTokens - policy.reservedOutputTokens;

    const allTurns = request.conversationState.turns;
    const maxTurns = Math.max(
      1,
      Math.ceil(policy.maxRecentTurns * retryConfig.maxRecentTurnsFraction),
    );
    const artifactCap = Math.ceil(
      policy.artifactInlineCharCap * retryConfig.artifactCapFraction,
    );

    // Separate current turn from completed turns
    const currentTurn =
      allTurns.length > 0 && !allTurns[allTurns.length - 1].completedAt
        ? allTurns[allTurns.length - 1]
        : undefined;
    const completedTurns = currentTurn
      ? allTurns.slice(0, allTurns.length - 1)
      : [...allTurns];

    const coveredIds = request.summaryCoveredTurnIds;
    const hasCoveredIds = !!(coveredIds && coveredIds.size > 0);

    let rollingSummaryTokens = 0;
    if (request.rollingSummary) {
      rollingSummaryTokens = estimateTokens(
        request.rollingSummary.length + SESSION_SUMMARY_WRAPPER_OVERHEAD,
      );
    }

    // --- First pass: select turns WITHOUT assuming the summary is used.
    // This determines which turns would be omitted by budget alone.
    // We then check whether the summary actually covers all of them. ---

    const systemBase = this.composeSystemBase(request);
    const baseSystemTokens = estimateTokens(systemBase.length);

    // Reserve budget for current turn
    let currentTurnTokens = 0;
    if (currentTurn) {
      currentTurnTokens = this.estimateTurnTokens(
        currentTurn,
        request,
        true,
        artifactCap,
      );
    }

    let extraInstructionTokens = 0;
    if (request.extraUserInstruction) {
      extraInstructionTokens = estimateTokens(
        request.extraUserInstruction.length,
      );
    }

    let preambleTokens = 0;
    for (const msg of request.conversationState.preamble) {
      preambleTokens += estimateTokens(messageChars(msg));
    }

    const fixedOverhead =
      baseSystemTokens +
      preambleTokens +
      currentTurnTokens +
      extraInstructionTokens;

    // --- Attempt a summary-aware build first if we have summary coverage ---

    if (hasCoveredIds && request.rollingSummary) {
      const summaryResult = this.buildWithSummary(
        request,
        completedTurns,
        currentTurn,
        coveredIds!,
        inputBudget,
        fixedOverhead,
        rollingSummaryTokens,
        maxTurns,
        artifactCap,
      );

      // Guard: only use the summary if every omitted turn is actually
      // covered by it. If budget pressure dropped uncovered turns, fall
      // through to the no-summary path so those turns stay visible.
      const uncoveredOmissions = summaryResult.omittedTurnIds.filter(
        (id) => !coveredIds!.has(id),
      );
      if (uncoveredOmissions.length === 0) {
        return this.assemblePlan(
          request,
          `${systemBase}\n\n<session_summary>\n${request.rollingSummary}\n</session_summary>`,
          summaryResult.selectedTurns,
          currentTurn,
          summaryResult.omittedTurnIds,
          true,
          artifactCap,
        );
      }
    }

    // --- No-summary path: all completed turns compete for budget ---

    const turnLimit = currentTurn ? maxTurns - 1 : maxTurns;
    const noSummaryResult = this.selectTurnsByBudget(
      completedTurns,
      request,
      inputBudget - fixedOverhead,
      turnLimit,
      artifactCap,
    );

    // If turns were omitted by budget and a summary exists that covers
    // every one of them, rebuild via the summary-aware path so the
    // summary token cost is properly reserved in the budget.
    if (
      request.rollingSummary &&
      hasCoveredIds &&
      noSummaryResult.omittedTurnIds.length > 0 &&
      noSummaryResult.omittedTurnIds.every((id) => coveredIds!.has(id))
    ) {
      const summaryResult = this.buildWithSummary(
        request,
        completedTurns,
        currentTurn,
        coveredIds!,
        inputBudget,
        fixedOverhead,
        rollingSummaryTokens,
        maxTurns,
        artifactCap,
      );
      return this.assemblePlan(
        request,
        `${systemBase}\n\n<session_summary>\n${request.rollingSummary}\n</session_summary>`,
        summaryResult.selectedTurns,
        currentTurn,
        summaryResult.omittedTurnIds,
        true,
        artifactCap,
      );
    }

    return this.assemblePlan(
      request,
      systemBase,
      noSummaryResult.selectedTurns,
      currentTurn,
      noSummaryResult.omittedTurnIds,
      false,
      artifactCap,
    );
  }

  // -----------------------------------------------------------------------
  // Summary-aware turn selection: pre-filters covered turns, then budgets
  // the remaining candidates.
  // -----------------------------------------------------------------------

  private buildWithSummary(
    request: PromptBuildRequest,
    completedTurns: TurnRecord[],
    currentTurn: TurnRecord | undefined,
    coveredIds: ReadonlySet<string>,
    inputBudget: number,
    fixedOverhead: number,
    summaryTokens: number,
    maxTurns: number,
    artifactCap: number,
  ): { selectedTurns: TurnRecord[]; omittedTurnIds: string[] } {
    const candidateTurns = completedTurns.filter((t) => !coveredIds.has(t.id));
    const coveredOmitted = completedTurns
      .filter((t) => coveredIds.has(t.id))
      .map((t) => t.id);

    const budgetForHistory = Math.max(
      0,
      inputBudget - fixedOverhead - summaryTokens,
    );
    const turnLimit = currentTurn ? maxTurns - 1 : maxTurns;

    const result = this.selectTurnsByBudget(
      candidateTurns,
      request,
      budgetForHistory,
      turnLimit,
      artifactCap,
    );

    return {
      selectedTurns: result.selectedTurns,
      omittedTurnIds: [...coveredOmitted, ...result.omittedTurnIds],
    };
  }

  // -----------------------------------------------------------------------
  // Shared budget-driven turn selection (newest-first)
  // -----------------------------------------------------------------------

  private selectTurnsByBudget(
    candidateTurns: ReadonlyArray<TurnRecord>,
    request: PromptBuildRequest,
    budgetTokens: number,
    turnLimit: number,
    artifactCap: number,
  ): { selectedTurns: TurnRecord[]; omittedTurnIds: string[] } {
    const selected: TurnRecord[] = [];
    const omitted: string[] = [];
    let remaining = budgetTokens;

    for (let i = candidateTurns.length - 1; i >= 0; i--) {
      if (selected.length >= turnLimit) {
        omitted.push(candidateTurns[i].id);
        continue;
      }
      const turnTokens = this.estimateTurnTokens(
        candidateTurns[i],
        request,
        false,
        artifactCap,
      );
      if (turnTokens <= remaining) {
        selected.unshift(candidateTurns[i]);
        remaining -= turnTokens;
      } else {
        omitted.push(candidateTurns[i].id);
      }
    }

    return { selectedTurns: selected, omittedTurnIds: omitted };
  }

  // -----------------------------------------------------------------------
  // Assemble the final PromptPlan from selected components
  // -----------------------------------------------------------------------

  private assemblePlan(
    request: PromptBuildRequest,
    systemContent: string,
    selectedCompletedTurns: TurnRecord[],
    currentTurn: TurnRecord | undefined,
    omittedTurnIds: string[],
    usedRollingSummary: boolean,
    artifactCap: number,
  ): PromptPlan {
    const messages: ChatMessage[] = [
      { role: "system", content: systemContent },
    ];

    for (const msg of request.conversationState.preamble) {
      messages.push(msg);
    }

    const includedTurnIds: string[] = [];
    const includedArtifactIds: string[] = [];

    for (const turn of selectedCompletedTurns) {
      includedTurnIds.push(turn.id);
      this.appendTurnMessages(
        messages,
        turn,
        request,
        false,
        artifactCap,
        includedArtifactIds,
      );
    }

    if (currentTurn) {
      includedTurnIds.push(currentTurn.id);
      this.appendTurnMessages(
        messages,
        currentTurn,
        request,
        true,
        artifactCap,
        includedArtifactIds,
      );
    }

    if (request.extraUserInstruction) {
      messages.push({ role: "user", content: request.extraUserInstruction });
    }

    const metrics = measureMessages(messages);

    return {
      messages,
      estimatedPromptTokens: metrics.estimatedTokens,
      reservedOutputTokens: request.policy.reservedOutputTokens,
      includedTurnIds,
      includedArtifactIds,
      omittedTurnIds,
      usedRollingSummary,
      retryLevel: request.retryLevel ?? 0,
    };
  }

  // -----------------------------------------------------------------------
  // Minimal plan (retry level 3)
  // -----------------------------------------------------------------------

  private buildMinimalPlan(request: PromptBuildRequest): PromptPlan {
    const systemBase = this.composeSystemBase(request);
    const messages: ChatMessage[] = [{ role: "system", content: systemBase }];

    const allTurns = request.conversationState.turns;
    const currentTurn =
      allTurns.length > 0 && !allTurns[allTurns.length - 1].completedAt
        ? allTurns[allTurns.length - 1]
        : undefined;

    const includedTurnIds: string[] = [];
    const includedArtifactIds: string[] = [];
    const omittedTurnIds: string[] = [];

    // Omit all completed turns
    for (const t of allTurns) {
      if (t !== currentTurn) {
        omittedTurnIds.push(t.id);
      }
    }

    if (currentTurn) {
      includedTurnIds.push(currentTurn.id);
      messages.push(currentTurn.userMessage);

      // Only include unresolved trailing tool chain
      let lastAssistantIdx = -1;
      for (let i = currentTurn.entries.length - 1; i >= 0; i--) {
        if (currentTurn.entries[i].kind === "assistant") {
          lastAssistantIdx = i;
          break;
        }
      }

      if (lastAssistantIdx >= 0) {
        messages.push(currentTurn.entries[lastAssistantIdx].message);
      }
      for (let i = lastAssistantIdx + 1; i < currentTurn.entries.length; i++) {
        const entry = currentTurn.entries[i];
        if (entry.kind === "tool") {
          const rehydrated = this.rehydrateToolMessage(
            entry,
            request,
            REHYDRATION_MAX_CHARS,
            includedArtifactIds,
          );
          messages.push(rehydrated);
        }
      }
    }

    if (request.extraUserInstruction) {
      messages.push({ role: "user", content: request.extraUserInstruction });
    }

    const metrics = measureMessages(messages);

    return {
      messages,
      estimatedPromptTokens: metrics.estimatedTokens,
      reservedOutputTokens: request.policy.reservedOutputTokens,
      includedTurnIds,
      includedArtifactIds,
      omittedTurnIds,
      usedRollingSummary: false,
      retryLevel: 3,
    };
  }

  // -----------------------------------------------------------------------
  // Turn message assembly helpers
  // -----------------------------------------------------------------------

  private appendTurnMessages(
    messages: ChatMessage[],
    turn: TurnRecord,
    request: PromptBuildRequest,
    isCurrentTurn: boolean,
    artifactCap: number,
    includedArtifactIds: string[],
  ): void {
    messages.push(turn.userMessage);

    let lastAssistantIdx = -1;
    if (isCurrentTurn) {
      for (let i = turn.entries.length - 1; i >= 0; i--) {
        if (turn.entries[i].kind === "assistant") {
          lastAssistantIdx = i;
          break;
        }
      }
    }

    for (let i = 0; i < turn.entries.length; i++) {
      const entry = turn.entries[i];
      const isUnresolved =
        isCurrentTurn &&
        i > lastAssistantIdx &&
        entry.kind === "tool" &&
        "toolInvocations" in entry;

      if (isUnresolved) {
        const rehydrated = this.rehydrateToolMessage(
          entry,
          request,
          artifactCap,
          includedArtifactIds,
        );
        messages.push(rehydrated);
      } else {
        // Resolved/completed tool entries use summary content only;
        // their artifact IDs are NOT recorded in includedArtifactIds
        // because the raw artifact body is not inlined into the payload.
        messages.push(entry.message);
      }
    }
  }

  private rehydrateToolMessage(
    entry: TurnEntry,
    request: PromptBuildRequest,
    artifactCap: number,
    includedArtifactIds: string[],
  ): ChatMessage {
    if (
      entry.kind !== "tool" ||
      !("toolInvocations" in entry) ||
      !entry.toolInvocations ||
      !entry.message.toolResults
    ) {
      return entry.message;
    }

    const effectiveCap = Math.min(artifactCap, REHYDRATION_MAX_CHARS);

    const rehydratedResults = entry.message.toolResults.map((tr, i) => {
      const invocation = entry.toolInvocations![i];
      if (!invocation) return tr;

      includedArtifactIds.push(invocation.artifactId);
      const artifact = request.artifactLookup(invocation.artifactId);
      if (artifact && typeof artifact.content === "string") {
        const capped = capForRehydrationWithCap(artifact.content, effectiveCap);
        return { ...tr, content: capped };
      }
      return tr;
    });

    return {
      ...entry.message,
      toolResults: rehydratedResults,
    };
  }

  // -----------------------------------------------------------------------
  // Token estimation for turns
  // -----------------------------------------------------------------------

  private estimateTurnTokens(
    turn: TurnRecord,
    request: PromptBuildRequest,
    isCurrentTurn: boolean,
    artifactCap: number,
  ): number {
    let chars = messageChars(turn.userMessage);

    let lastAssistantIdx = -1;
    if (isCurrentTurn) {
      for (let i = turn.entries.length - 1; i >= 0; i--) {
        if (turn.entries[i].kind === "assistant") {
          lastAssistantIdx = i;
          break;
        }
      }
    }

    for (let i = 0; i < turn.entries.length; i++) {
      const entry = turn.entries[i];
      const isUnresolved =
        isCurrentTurn &&
        i > lastAssistantIdx &&
        entry.kind === "tool" &&
        "toolInvocations" in entry;

      if (isUnresolved && entry.kind === "tool" && entry.toolInvocations) {
        // Estimate using rehydrated content size
        let entryChars = 0;
        for (const inv of entry.toolInvocations) {
          const artifact = request.artifactLookup(inv.artifactId);
          if (artifact && typeof artifact.content === "string") {
            const effectiveCap = Math.min(artifactCap, REHYDRATION_MAX_CHARS);
            entryChars += Math.min(artifact.content.length, effectiveCap);
          } else {
            entryChars += inv.resultSummary.length;
          }
        }
        chars += entryChars;
      } else {
        chars += messageChars(entry.message);
      }
    }

    return estimateTokens(chars);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function messageChars(msg: ChatMessage): number {
  let chars = msg.content.length;
  if (msg.toolCalls) {
    chars += JSON.stringify(msg.toolCalls).length;
  }
  if (msg.toolResults) {
    chars += JSON.stringify(msg.toolResults).length;
  }
  return chars;
}

function capForRehydrationWithCap(rawContent: string, cap: number): string {
  if (rawContent.length <= cap) {
    return rawContent;
  }
  const truncated = rawContent.substring(0, cap);
  const omitted = rawContent.length - cap;
  return `${truncated}\n\n[output truncated: ${omitted} chars omitted]`;
}
