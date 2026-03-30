import type {
  ConversationState,
  TurnRecord,
  TurnEntry,
} from "../context/types.js";
import type { ChatMessage } from "../providers/types.js";
import type { PromptPlanSnapshot } from "../agent.js";
import { estimateTokens } from "../diagnostics.js";

// ---------------------------------------------------------------------------
// Retry level labels (0-3)
// ---------------------------------------------------------------------------

const RETRY_LEVEL_LABELS: Record<number, string> = {
  0: "initial build (full budget)",
  1: "fewer historical turns",
  2: "tighter artifact/content caps",
  3: "minimal prompt (system + current turn only)",
};

function retryLevelLabel(level: number): string {
  return RETRY_LEVEL_LABELS[level] ?? `unknown (${level})`;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function previewText(text: string, maxLen = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}

function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

// ---------------------------------------------------------------------------
// Context overview (/context)
// ---------------------------------------------------------------------------

export interface ContextOverviewLine {
  readonly text: string;
  readonly style: "info" | "subtle" | "section";
}

export function formatContextOverview(
  state: ConversationState,
): ContextOverviewLine[] {
  const lines: ContextOverviewLine[] = [];

  const preambleCount = state.preamble.length;
  const turnCount = state.turns.length;
  const artifactCount = state.artifacts.length;
  const activePinned = state.pinnedMemory.filter(
    (r) => r.lifecycle === "active",
  );

  let preambleTokens = 0;
  for (const msg of state.preamble) {
    preambleTokens += estimateTokens(estimateMessageChars(msg));
  }

  let turnTokens = 0;
  for (const turn of state.turns) {
    if (turn.estimatedTokens != null) turnTokens += turn.estimatedTokens;
  }

  const totalEstimatedTokens = preambleTokens + turnTokens;
  const summaryTokens = state.rollingSummary?.estimatedTokens ?? 0;

  lines.push({
    text: "Context Overview",
    style: "section",
  });

  if (preambleCount > 0) {
    lines.push({
      text: `  Preamble: ${preambleCount} ${plural(preambleCount, "message")}`,
      style: "info",
    });
  }
  lines.push({
    text: `  Turns: ${turnCount}`,
    style: "info",
  });
  lines.push({
    text: `  Estimated conversation tokens: ~${totalEstimatedTokens} (estimated, stored conversation)`,
    style: "info",
  });
  lines.push({
    text: `  Rolling summary: ${state.rollingSummary ? `~${summaryTokens} tokens (estimated), covering ${state.rollingSummary.coveredTurnIds.length} ${plural(state.rollingSummary.coveredTurnIds.length, "turn")}` : "none"}`,
    style: "info",
  });
  lines.push({
    text: `  Artifacts: ${artifactCount}`,
    style: "info",
  });
  lines.push({
    text: `  Pinned memory: ${activePinned.length} active ${plural(activePinned.length, "record")}`,
    style: "info",
  });

  if (preambleCount > 0) {
    lines.push({ text: "", style: "subtle" });
    lines.push({ text: "Preamble", style: "section" });

    for (const msg of state.preamble) {
      const preview = previewText(msg.content);
      lines.push({
        text: `  ${msg.role.toUpperCase()}: ${preview}`,
        style: "info",
      });
    }
  }

  if (turnCount > 0) {
    lines.push({ text: "", style: "subtle" });
    lines.push({ text: "Turns", style: "section" });

    for (const turn of state.turns) {
      const status = turn.completedAt ? "completed" : "in-progress";
      const userPreview = previewText(turn.userMessage.content);
      const entryInfo = formatTurnEntrySummary(turn.entries);
      const tokenLabel =
        turn.estimatedTokens != null
          ? ` ~${turn.estimatedTokens} tokens (est.)`
          : "";

      lines.push({
        text: `  [${status}] ${userPreview}`,
        style: "info",
      });

      const details: string[] = [];
      if (entryInfo) details.push(entryInfo);
      if (turn.importance !== "normal")
        details.push(`importance=${turn.importance}`);
      if (tokenLabel) details.push(tokenLabel.trim());
      if (turn.entries.some(hasArtifactReference)) {
        const artIds = collectArtifactIds(turn.entries);
        details.push(`${artIds.length} ${plural(artIds.length, "artifact")}`);
      }

      if (details.length > 0) {
        lines.push({
          text: `    ${details.join(" | ")}`,
          style: "subtle",
        });
      }
    }
  }

  return lines;
}

function formatTurnEntrySummary(entries: ReadonlyArray<TurnEntry>): string {
  const assistantCount = entries.filter((e) => e.kind === "assistant").length;
  const toolEntries = entries.filter((e) => e.kind === "tool");
  const toolNames: string[] = [];
  const statusCounts = { success: 0, error: 0 };

  for (const entry of toolEntries) {
    if (entry.kind === "tool") {
      for (const inv of entry.toolInvocations) {
        if (!toolNames.includes(inv.toolName)) toolNames.push(inv.toolName);
        statusCounts[inv.status]++;
      }
    }
  }

  const parts: string[] = [];
  if (assistantCount > 0) {
    parts.push(`${assistantCount} ${plural(assistantCount, "response")}`);
  }
  if (toolNames.length > 0) {
    const toolLabel = toolNames.join(", ");
    const statusParts: string[] = [];
    if (statusCounts.success > 0)
      statusParts.push(`${statusCounts.success} ok`);
    if (statusCounts.error > 0)
      statusParts.push(`${statusCounts.error} failed`);
    parts.push(`tools: ${toolLabel} (${statusParts.join(", ")})`);
  }

  return parts.join(" | ");
}

function estimateMessageChars(msg: ChatMessage): number {
  let chars = msg.content.length;
  if (msg.toolCalls) chars += JSON.stringify(msg.toolCalls).length;
  if (msg.toolResults) chars += JSON.stringify(msg.toolResults).length;
  return chars;
}

function hasArtifactReference(entry: TurnEntry): boolean {
  if (entry.kind !== "tool") return false;
  return entry.toolInvocations.some((inv) => inv.artifactId);
}

function collectArtifactIds(entries: ReadonlyArray<TurnEntry>): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "tool") {
      for (const inv of entry.toolInvocations) {
        if (inv.artifactId && !ids.includes(inv.artifactId)) {
          ids.push(inv.artifactId);
        }
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Compact context stats (for --show-context-stats live output)
// ---------------------------------------------------------------------------

export function formatContextStats(state: ConversationState): string {
  const turnCount = state.turns.length;
  let totalTokens = 0;
  for (const msg of state.preamble) {
    totalTokens += estimateTokens(estimateMessageChars(msg));
  }
  for (const turn of state.turns) {
    if (turn.estimatedTokens != null) totalTokens += turn.estimatedTokens;
  }
  const artifactCount = state.artifacts.length;
  const summaryTokens = state.rollingSummary?.estimatedTokens ?? 0;
  const pinnedCount = state.pinnedMemory.filter(
    (r) => r.lifecycle === "active",
  ).length;

  const preambleLabel =
    state.preamble.length > 0
      ? `${state.preamble.length} preamble + `
      : "";

  return `Context: ${preambleLabel}${turnCount} ${plural(turnCount, "turn")} | ~${totalTokens} conversation tokens (est.) | ${artifactCount} ${plural(artifactCount, "artifact")} | summary ~${summaryTokens} tokens | ${pinnedCount} pinned`;
}

// ---------------------------------------------------------------------------
// Prompt plan details (/context prompt)
// ---------------------------------------------------------------------------

export interface PromptPlanLine {
  readonly text: string;
  readonly style: "info" | "subtle" | "section";
}

export function formatPromptPlan(
  snapshot: PromptPlanSnapshot,
): PromptPlanLine[] {
  const lines: PromptPlanLine[] = [];
  const { plan } = snapshot;

  lines.push({ text: "Prompt Plan", style: "section" });
  lines.push({ text: `  Provider: ${snapshot.provider}`, style: "info" });
  lines.push({ text: `  Model: ${snapshot.model}`, style: "info" });
  lines.push({
    text: `  Iteration: ${snapshot.iteration}`,
    style: "info",
  });
  lines.push({
    text: `  Context window: ${snapshot.contextWindowTokens} tokens`,
    style: "info",
  });
  lines.push({
    text: `  Available input budget: ${snapshot.availableInputBudget} tokens`,
    style: "info",
  });
  lines.push({
    text: `  Estimated prompt tokens: ~${plan.estimatedPromptTokens} (estimated)`,
    style: "info",
  });
  lines.push({
    text: `  Reserved output tokens: ${plan.reservedOutputTokens}`,
    style: "info",
  });
  lines.push({
    text: `  Retry level: ${plan.retryLevel} — ${retryLevelLabel(plan.retryLevel)}`,
    style: "info",
  });

  lines.push({ text: "", style: "subtle" });
  lines.push({
    text: `  Included turns: ${plan.includedTurnIds.length}${plan.includedTurnIds.length > 0 ? ` (${plan.includedTurnIds.join(", ")})` : ""}`,
    style: "subtle",
  });
  lines.push({
    text: `  Omitted turns: ${plan.omittedTurnIds.length}${plan.omittedTurnIds.length > 0 ? ` (${plan.omittedTurnIds.join(", ")})` : ""}`,
    style: "subtle",
  });
  lines.push({
    text: `  Inlined artifacts: ${plan.includedArtifactIds.length}${plan.includedArtifactIds.length > 0 ? ` (${plan.includedArtifactIds.join(", ")})` : ""}`,
    style: "subtle",
  });
  lines.push({
    text: `  Used rolling summary: ${plan.usedRollingSummary ? "yes" : "no"}`,
    style: "subtle",
  });

  if (plan.messages.length > 0) {
    lines.push({ text: "", style: "subtle" });
    lines.push({ text: "Prompt Messages", style: "section" });
    for (const msg of plan.messages) {
      const preview = previewText(msg.content, 100);
      const toolCallNote =
        msg.toolCalls && msg.toolCalls.length > 0
          ? ` [+${msg.toolCalls.length} tool ${plural(msg.toolCalls.length, "call")}]`
          : "";
      const toolResultNote =
        msg.toolResults && msg.toolResults.length > 0
          ? ` [${msg.toolResults.length} tool ${plural(msg.toolResults.length, "result")}]`
          : "";
      lines.push({
        text: `  ${msg.role.toUpperCase()}: ${preview}${toolCallNote}${toolResultNote}`,
        style: "subtle",
      });
    }
  }

  return lines;
}

/**
 * Compact single-line prompt plan summary for --show-prompt-plan live output.
 */
export function formatPromptPlanCompact(snapshot: PromptPlanSnapshot): string {
  const { plan } = snapshot;
  return (
    `Prompt plan: ${snapshot.provider}/${snapshot.model} iter=${snapshot.iteration} | ` +
    `~${plan.estimatedPromptTokens} prompt tokens (est.) | ` +
    `${plan.includedTurnIds.length} included, ${plan.omittedTurnIds.length} omitted | ` +
    `retry=${plan.retryLevel} (${retryLevelLabel(plan.retryLevel)}) | ` +
    `summary=${plan.usedRollingSummary ? "yes" : "no"}`
  );
}

// ---------------------------------------------------------------------------
// Memory details (/context memory)
// ---------------------------------------------------------------------------

export interface MemoryLine {
  readonly text: string;
  readonly style: "info" | "subtle" | "section";
}

export function formatMemoryView(state: ConversationState): MemoryLine[] {
  const lines: MemoryLine[] = [];

  lines.push({ text: "Memory & Summary", style: "section" });

  // Rolling summary
  lines.push({ text: "", style: "subtle" });
  lines.push({ text: "Rolling Summary", style: "section" });
  if (state.rollingSummary) {
    const { rollingSummary: rs } = state;
    lines.push({
      text: `  Covered turns: ${rs.coveredTurnIds.length} (${rs.coveredTurnIds.join(", ")})`,
      style: "info",
    });
    lines.push({
      text: `  Estimated tokens: ~${rs.estimatedTokens} (estimated)`,
      style: "info",
    });
    lines.push({
      text: `  Updated at: ${rs.updatedAt}`,
      style: "subtle",
    });
    lines.push({ text: "", style: "subtle" });
    lines.push({ text: "  Summary text:", style: "info" });
    for (const line of rs.content.split("\n")) {
      lines.push({ text: `    ${line}`, style: "subtle" });
    }
  } else {
    lines.push({ text: "  No rolling summary yet.", style: "subtle" });
  }

  // Pinned memory
  lines.push({ text: "", style: "subtle" });
  lines.push({ text: "Pinned Memory", style: "section" });
  const activeRecords = state.pinnedMemory.filter(
    (r) => r.lifecycle === "active",
  );

  if (activeRecords.length === 0) {
    lines.push({ text: "  No active pinned memory records.", style: "subtle" });
  } else {
    for (const record of activeRecords) {
      lines.push({
        text: `  [${record.kind}] (${record.scope}) ${record.content}`,
        style: "info",
      });
      const details: string[] = [];
      details.push(`source: ${record.source.origin}`);
      if (record.rationale) details.push(`rationale: ${record.rationale}`);
      details.push(`lifecycle: ${record.lifecycle}`);
      details.push(`created: ${record.createdAt}`);
      lines.push({
        text: `    ${details.join(" | ")}`,
        style: "subtle",
      });
    }
  }

  return lines;
}
