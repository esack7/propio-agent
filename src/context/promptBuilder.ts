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
} from "./types.js";

// ---------------------------------------------------------------------------
// Build request: everything the builder needs to produce a plan
// ---------------------------------------------------------------------------

export interface PromptBuildRequest {
  readonly systemPrompt: string;
  readonly conversationState: ConversationState;
  readonly contextWindowTokens: number;
  readonly policy: PromptBudgetPolicy;
  readonly extraUserInstruction?: string;
  readonly rollingSummary?: string;
  readonly retryLevel?: number;
  readonly artifactLookup: (id: string) => ArtifactRecord | undefined;
  readonly isCurrentTurnUnresolved: (turnId: string) => boolean;
}

// ---------------------------------------------------------------------------
// Rehydration cap (matches ContextManager constant)
// ---------------------------------------------------------------------------

const REHYDRATION_MAX_CHARS = 12000;

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

    const systemMsg: ChatMessage = {
      role: "system",
      content: request.systemPrompt,
    };
    const systemTokens = estimateTokens(request.systemPrompt.length);

    let remainingTokens = inputBudget - systemTokens;
    const messages: ChatMessage[] = [systemMsg];

    // Preamble messages (pre-turn)
    for (const msg of request.conversationState.preamble) {
      messages.push(msg);
      remainingTokens -= estimateTokens(messageChars(msg));
    }

    // Determine which turns to include. Current (incomplete) turn always
    // gets priority; completed turns fill remaining budget newest-first.
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

    // Reserve budget for current turn first
    let currentTurnTokens = 0;
    if (currentTurn) {
      currentTurnTokens = this.estimateTurnTokens(
        currentTurn,
        request,
        true,
        artifactCap,
      );
    }

    // Reserve budget for extra user instruction
    let extraInstructionTokens = 0;
    if (request.extraUserInstruction) {
      extraInstructionTokens = estimateTokens(
        request.extraUserInstruction.length,
      );
    }

    // Reserve budget for rolling summary
    let rollingSummaryTokens = 0;
    if (request.rollingSummary) {
      rollingSummaryTokens = estimateTokens(request.rollingSummary.length);
    }

    const reservedForCurrentAndExtras =
      currentTurnTokens + extraInstructionTokens + rollingSummaryTokens;
    let budgetForHistory = Math.max(
      0,
      remainingTokens - reservedForCurrentAndExtras,
    );

    // Select completed turns (newest-first) within budget and turn cap
    const selectedCompletedTurns: TurnRecord[] = [];
    const omittedTurnIds: string[] = [];
    const turnLimit = currentTurn ? maxTurns - 1 : maxTurns;

    for (let i = completedTurns.length - 1; i >= 0; i--) {
      if (selectedCompletedTurns.length >= turnLimit) {
        omittedTurnIds.push(completedTurns[i].id);
        continue;
      }
      const turnTokens = this.estimateTurnTokens(
        completedTurns[i],
        request,
        false,
        artifactCap,
      );
      if (turnTokens <= budgetForHistory) {
        selectedCompletedTurns.unshift(completedTurns[i]);
        budgetForHistory -= turnTokens;
      } else {
        omittedTurnIds.push(completedTurns[i].id);
      }
    }

    // Collect the rest of the omitted IDs (turns before the oldest selected)
    for (let i = 0; i < completedTurns.length; i++) {
      const t = completedTurns[i];
      if (
        !selectedCompletedTurns.includes(t) &&
        !omittedTurnIds.includes(t.id)
      ) {
        omittedTurnIds.push(t.id);
      }
    }

    // Insert rolling summary if available and turns were omitted
    let usedRollingSummary = false;
    if (request.rollingSummary && omittedTurnIds.length > 0) {
      messages.push({ role: "user", content: request.rollingSummary });
      remainingTokens -= rollingSummaryTokens;
      usedRollingSummary = true;
    }

    // Assemble messages for selected completed turns
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

    // Assemble messages for current turn
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

    // Extra user instruction
    if (request.extraUserInstruction) {
      messages.push({ role: "user", content: request.extraUserInstruction });
    }

    const metrics = measureMessages(messages);

    return {
      messages,
      estimatedPromptTokens: metrics.estimatedTokens,
      reservedOutputTokens: policy.reservedOutputTokens,
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
    const messages: ChatMessage[] = [
      { role: "system", content: request.systemPrompt },
    ];

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
        if (
          entry.kind === "tool" &&
          "toolInvocations" in entry &&
          entry.toolInvocations
        ) {
          for (const inv of entry.toolInvocations) {
            if (inv.artifactId) {
              includedArtifactIds.push(inv.artifactId);
            }
          }
        }
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
