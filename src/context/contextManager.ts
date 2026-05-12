import { randomUUID } from "crypto";
import { ChatMessage, ChatToolCall, ToolResult } from "../providers/types.js";
import {
  estimateTokens,
  measureMessages,
  RESERVED_OUTPUT_TOKENS,
} from "../diagnostics.js";
import {
  PromptPlan,
  PromptBudgetPolicy,
  DEFAULT_BUDGET_POLICY,
  SummaryPolicy,
  DEFAULT_SUMMARY_POLICY,
  TurnEntry,
  TurnRecord,
  ConversationState,
  ArtifactRecord,
  ToolInvocationRecord,
  ArtifactToolResult,
  RollingSummaryRecord,
  PinnedMemoryRecord,
  PinFactInput,
  UpdateMemoryInput,
} from "./types.js";
import type { InvokedSkillRecord } from "../skills/types.js";
import {
  validatePinInput,
  validateUpdateInput,
  isDuplicateActive,
  supersedRecord,
  removeRecord,
  renderPinnedMemoryBlock,
  clonePinnedRecord,
  MemoryValidationError,
} from "./memoryManager.js";
import { cloneInvokedSkillRecord } from "../skills/shared.js";
import { PromptBuilder, PromptBuildRequest } from "./promptBuilder.js";
import {
  computeSummaryEligibility,
  SummaryEligibility,
} from "./summaryManager.js";
import { renderInvokedSkillBlock } from "./invokedSkillRenderer.js";
import { findLastAssistantEntryIndex } from "./turnUtils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Default values for summary and rehydration limits
const DEFAULT_SUMMARY_MAX_CHARS = 1500;
const DEFAULT_REHYDRATION_MAX_CHARS = 12000;

// ---------------------------------------------------------------------------
// Internal mutable counterparts of the public readonly types.  The public
// API returns deep-cloned readonly data; internally we mutate freely.
// ---------------------------------------------------------------------------

interface MutableToolInvocation {
  toolCallId: string;
  toolName: string;
  status: "success" | "error";
  resultSummary: string;
  artifactId: string;
  mediaType: string;
  contentSizeChars: number;
  estimatedTokens?: number;
}

interface MutableArtifact {
  id: string;
  type:
    | "tool_result"
    | "file_snapshot"
    | "command_output"
    | "image"
    | "pdf"
    | "other";
  mediaType: string;
  createdAt: string;
  content: string | Uint8Array;
  contentSizeChars: number;
  estimatedTokens?: number;
  referencingTurnIds: string[];
}

interface MutableTurnEntry {
  kind: "assistant" | "tool";
  createdAt: string;
  estimatedTokens?: number;
  message: ChatMessage;
  toolInvocations?: MutableToolInvocation[];
}

interface MutableTurnRecord {
  id: string;
  startedAt: string;
  completedAt?: string;
  importance: "low" | "normal" | "high";
  summary?: string;
  estimatedTokens?: number;
  userMessage: ChatMessage;
  entries: MutableTurnEntry[];
}

// ---------------------------------------------------------------------------
// Cloning helpers
// ---------------------------------------------------------------------------

function cloneMessage(msg: ChatMessage): ChatMessage {
  const clone: ChatMessage = { role: msg.role, content: msg.content };
  if (msg.reasoningContent !== undefined) {
    clone.reasoningContent = msg.reasoningContent;
  }
  if (msg.toolCalls) {
    clone.toolCalls = msg.toolCalls.map((tc) => ({
      ...tc,
      function: {
        ...tc.function,
        arguments: structuredClone(tc.function.arguments),
      },
    }));
  }
  if (msg.toolCallId !== undefined) {
    clone.toolCallId = msg.toolCallId;
  }
  if (msg.toolResults) {
    clone.toolResults = msg.toolResults.map((tr) => ({ ...tr }));
  }
  if (msg.images) {
    clone.images = msg.images.map((img) =>
      img instanceof Uint8Array ? new Uint8Array(img) : img,
    );
  }
  return clone;
}

function cloneInvocation(inv: MutableToolInvocation): ToolInvocationRecord {
  return { ...inv };
}

function cloneEntry(entry: MutableTurnEntry): TurnEntry {
  const base = {
    kind: entry.kind,
    createdAt: entry.createdAt,
    estimatedTokens: entry.estimatedTokens,
    message: cloneMessage(entry.message),
  };
  if (entry.kind === "tool" && entry.toolInvocations) {
    return {
      ...base,
      kind: "tool" as const,
      toolInvocations: entry.toolInvocations.map(cloneInvocation),
    };
  }
  return base as TurnEntry;
}

function cloneTurn(turn: MutableTurnRecord): TurnRecord {
  return {
    id: turn.id,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    importance: turn.importance,
    summary: turn.summary,
    estimatedTokens: turn.estimatedTokens,
    userMessage: cloneMessage(turn.userMessage),
    entries: turn.entries.map(cloneEntry),
  };
}

function cloneArtifact(artifact: MutableArtifact): ArtifactRecord {
  return {
    ...artifact,
    content:
      artifact.content instanceof Uint8Array
        ? new Uint8Array(artifact.content)
        : artifact.content,
    referencingTurnIds: [...artifact.referencingTurnIds],
  };
}

// ---------------------------------------------------------------------------
// Import helpers (readonly → mutable, used by importState)
// ---------------------------------------------------------------------------

function toMutableInvocation(inv: ToolInvocationRecord): MutableToolInvocation {
  return { ...inv };
}

function toMutableEntry(entry: TurnEntry): MutableTurnEntry {
  const base: MutableTurnEntry = {
    kind: entry.kind,
    createdAt: entry.createdAt,
    estimatedTokens: entry.estimatedTokens,
    message: cloneMessage(entry.message),
  };
  if (entry.kind === "tool") {
    base.toolInvocations = entry.toolInvocations.map(toMutableInvocation);
  }
  return base;
}

function toMutableTurnRecord(turn: TurnRecord): MutableTurnRecord {
  return {
    id: turn.id,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    importance: turn.importance,
    summary: turn.summary,
    estimatedTokens: turn.estimatedTokens,
    userMessage: cloneMessage(turn.userMessage),
    entries: turn.entries.map(toMutableEntry),
  };
}

function toMutableArtifactRecord(artifact: ArtifactRecord): MutableArtifact {
  return {
    id: artifact.id,
    type: artifact.type,
    mediaType: artifact.mediaType,
    createdAt: artifact.createdAt,
    content:
      artifact.content instanceof Uint8Array
        ? new Uint8Array(artifact.content)
        : artifact.content,
    contentSizeChars: artifact.contentSizeChars,
    estimatedTokens: artifact.estimatedTokens,
    referencingTurnIds: [...artifact.referencingTurnIds],
  };
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

function generateTextSummary(text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) {
    return text;
  }
  const truncated = text.substring(0, SUMMARY_MAX_CHARS);
  const omitted = text.length - SUMMARY_MAX_CHARS;
  return `${truncated}\n\n[... ${omitted} more chars truncated]`;
}

function generateBinarySummary(byteLength: number, mediaType: string): string {
  return `[binary content: ${byteLength} bytes, ${mediaType}]`;
}

function capForRehydration(rawContent: string): string {
  if (rawContent.length <= REHYDRATION_MAX_CHARS) {
    return rawContent;
  }
  const truncated = rawContent.substring(0, REHYDRATION_MAX_CHARS);
  const omitted = rawContent.length - REHYDRATION_MAX_CHARS;
  return `${truncated}\n\n[output truncated: ${omitted} chars omitted]`;
}

function resolveMediaType(result: ArtifactToolResult): string {
  if (result.mediaType) return result.mediaType;
  return typeof result.rawContent === "string"
    ? "text/plain"
    : "application/octet-stream";
}

function contentSizeChars(content: string | Uint8Array): number {
  return typeof content === "string" ? content.length : content.byteLength;
}

// ---------------------------------------------------------------------------
// Token estimation helpers (reuses the chars/4 heuristic from diagnostics)
// ---------------------------------------------------------------------------

function messageChars(msg: ChatMessage): number {
  let chars = msg.content.length;
  if (msg.reasoningContent) {
    chars += msg.reasoningContent.length;
  }
  if (msg.toolCalls) {
    chars += JSON.stringify(msg.toolCalls).length;
  }
  if (msg.toolResults) {
    chars += JSON.stringify(msg.toolResults).length;
  }
  return chars;
}

/**
 * ContextManager owns conversational state for an Agent session.
 *
 * Phase 3 adds artifact-backed tool output storage. Raw tool results are
 * stored as artifacts; only compact summaries persist in the canonical turn
 * entries. The prompt builder rehydrates full raw content from artifacts for
 * the current (incomplete) turn's tool messages, ensuring the model sees
 * complete evidence for immediate follow-up while older completed turns
 * carry only summaries.
 *
 * Tool results are committed in provider tool-call order. The API assumes
 * the current sequential execution model; it does not promise concurrent
 * mutation safety.
 */
export class ContextManager {
  private preTurnMessages: ChatMessage[] = [];
  private turns: MutableTurnRecord[] = [];
  private artifacts: Map<string, MutableArtifact> = new Map();
  private rollingSummary: RollingSummaryRecord | undefined;
  private pinnedMemory: PinnedMemoryRecord[] = [];
  private invokedSkills: InvokedSkillRecord[] = [];
  private summaryMaxChars: number;
  private rehydrationMaxChars: number;

  constructor(config?: { toolResultSummaryMaxChars?: number; rehydrationMaxChars?: number }) {
    this.summaryMaxChars = config?.toolResultSummaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
    this.rehydrationMaxChars = config?.rehydrationMaxChars ?? DEFAULT_REHYDRATION_MAX_CHARS;
  }

  // -------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------

  beginUserTurn(userMessage: string): void {
    this.turns.push({
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      importance: "normal",
      userMessage: { role: "user", content: userMessage },
      entries: [],
    });
  }

  commitAssistantResponse(
    content: string,
    toolCalls?: ChatToolCall[],
    options?: { reasoningContent?: string },
  ): void {
    const message: ChatMessage = { role: "assistant", content, toolCalls };
    if (options?.reasoningContent) {
      message.reasoningContent = options.reasoningContent;
    }

    const turn = this.currentTurn();
    if (!turn) {
      this.preTurnMessages.push(message);
      return;
    }

    turn.entries.push({
      kind: "assistant",
      createdAt: new Date().toISOString(),
      estimatedTokens: estimateTokens(messageChars(message)),
      message,
    });

    if (!toolCalls || toolCalls.length === 0) {
      this.completeTurn(turn);
    }
  }

  private generateTextSummary(text: string): string {
    if (text.length <= this.summaryMaxChars) {
      return text;
    }
    const truncated = text.substring(0, this.summaryMaxChars);
    const omitted = text.length - this.summaryMaxChars;
    return `${truncated}\n\n[... ${omitted} more chars truncated]`;
  }

  /**
   * Record tool results backed by artifacts. Each result is stored as an
   * artifact with the full raw content; the turn entry receives only a
   * compact summary. During prompt assembly, the current turn's tool
   * messages are rehydrated from artifacts for the provider.
   */
  recordToolResults(results: ArtifactToolResult[]): void {
    const turn = this.currentTurn();
    const turnId = turn?.id;

    const invocations: MutableToolInvocation[] = [];
    const toolResults: ToolResult[] = [];

    for (const result of results) {
      const artifactId = randomUUID();
      const mediaType = resolveMediaType(result);
      const size = contentSizeChars(result.rawContent);

      const summary =
        typeof result.rawContent === "string"
          ? this.generateTextSummary(result.rawContent)
          : generateBinarySummary(size, mediaType);

      const artifact: MutableArtifact = {
        id: artifactId,
        type: "tool_result",
        mediaType,
        createdAt: new Date().toISOString(),
        content: result.rawContent,
        contentSizeChars: size,
        estimatedTokens: estimateTokens(size),
        referencingTurnIds: turnId ? [turnId] : [],
      };

      // Copy external storage metadata if provided
      if (result.externalStorage) {
        (artifact as any).externalPath = result.externalStorage.externalPath;
        (artifact as any).externalSizeBytes = result.externalStorage.externalSizeBytes;
        (artifact as any).externalLineCount = result.externalStorage.externalLineCount;
      }

      this.artifacts.set(artifactId, artifact);

      invocations.push({
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        status: result.status,
        resultSummary: summary,
        artifactId,
        mediaType,
        contentSizeChars: size,
        estimatedTokens: estimateTokens(size),
      });

      toolResults.push({
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        content: summary,
      });
    }

    const message: ChatMessage = {
      role: "tool",
      content: "",
      toolResults,
    };

    if (!turn) {
      this.preTurnMessages.push(message);
      return;
    }

    turn.entries.push({
      kind: "tool",
      createdAt: new Date().toISOString(),
      estimatedTokens: estimateTokens(messageChars(message)),
      message,
      toolInvocations: invocations,
    });
  }

  removeLastUnresolvedAssistantMessage(): void {
    if (this.turns.length === 0) {
      const last = this.preTurnMessages[this.preTurnMessages.length - 1];
      if (
        last &&
        last.role === "assistant" &&
        last.toolCalls &&
        last.toolCalls.length > 0
      ) {
        this.preTurnMessages.pop();
      }
      return;
    }

    const turn = this.turns[this.turns.length - 1];
    if (turn.entries.length === 0) {
      return;
    }
    const lastAssistantIdx = findLastAssistantEntryIndex(turn.entries);
    if (lastAssistantIdx < 0 || lastAssistantIdx !== turn.entries.length - 1) {
      return;
    }
    const last = turn.entries[lastAssistantIdx];
    if (last.message.toolCalls && last.message.toolCalls.length > 0) {
      turn.entries.pop();
    }
  }

  clear(): void {
    this.preTurnMessages = [];
    this.turns = [];
    this.artifacts.clear();
    this.rollingSummary = undefined;
    this.pinnedMemory = [];
    this.invokedSkills = [];
  }

  /**
   * Atomically replace all in-memory state from a validated
   * ConversationState. The incoming state is deep-cloned so the caller
   * retains no mutable references into the manager's internals.
   */
  importState(state: ConversationState): void {
    this.preTurnMessages = state.preamble.map(cloneMessage);
    this.turns = state.turns.map(toMutableTurnRecord);

    this.artifacts.clear();
    for (const artifact of state.artifacts) {
      this.artifacts.set(artifact.id, toMutableArtifactRecord(artifact));
    }

    this.rollingSummary = state.rollingSummary
      ? {
          ...state.rollingSummary,
          coveredTurnIds: [...state.rollingSummary.coveredTurnIds],
        }
      : undefined;

    this.pinnedMemory = state.pinnedMemory
      ? state.pinnedMemory.map(clonePinnedRecord)
      : [];
    this.invokedSkills = state.invokedSkills
      ? state.invokedSkills.map(cloneInvokedSkillRecord)
      : [];
  }

  // -------------------------------------------------------------------
  // Read APIs
  // -------------------------------------------------------------------

  /**
   * Return a deep-cloned copy of the stored messages in flat chronological
   * order. Tool messages use summary content for all turns (both completed
   * and in-progress). For full raw content, use getConversationState()
   * to access artifacts by ID.
   */
  getSnapshot(): ChatMessage[] {
    const messages: ChatMessage[] = this.preTurnMessages.map(cloneMessage);
    for (const turn of this.turns) {
      messages.push(cloneMessage(turn.userMessage));
      for (const entry of turn.entries) {
        messages.push(cloneMessage(entry.message));
      }
    }
    return messages;
  }

  get messageCount(): number {
    let count = this.preTurnMessages.length;
    for (const turn of this.turns) {
      count += 1 + turn.entries.length;
    }
    return count;
  }

  getConversationState(): ConversationState {
    return {
      preamble: this.preTurnMessages.map(cloneMessage),
      turns: this.turns.map(cloneTurn),
      artifacts: Array.from(this.artifacts.values()).map(cloneArtifact),
      rollingSummary: this.rollingSummary
        ? {
            ...this.rollingSummary,
            coveredTurnIds: [...this.rollingSummary.coveredTurnIds],
          }
        : undefined,
      pinnedMemory: this.pinnedMemory.map(clonePinnedRecord),
      invokedSkills: this.invokedSkills.map(cloneInvokedSkillRecord),
    };
  }

  // -------------------------------------------------------------------
  // Rolling summary state
  // -------------------------------------------------------------------

  getRollingSummary(): RollingSummaryRecord | undefined {
    return this.rollingSummary
      ? {
          ...this.rollingSummary,
          coveredTurnIds: [...this.rollingSummary.coveredTurnIds],
        }
      : undefined;
  }

  /**
   * Atomically replace the stored rolling summary. Called after a
   * successful summary refresh. The previous summary is discarded.
   */
  setRollingSummary(summary: RollingSummaryRecord): void {
    this.rollingSummary = {
      ...summary,
      coveredTurnIds: [...summary.coveredTurnIds],
    };
  }

  /**
   * Compute summary eligibility based on completed turns and current
   * rolling summary state.
   */
  getSummaryEligibility(
    policy?: SummaryPolicy,
    estimatedPromptTokens?: number,
    availableInputBudget?: number,
  ): SummaryEligibility {
    const effectivePolicy = policy ?? DEFAULT_SUMMARY_POLICY;
    const completedTurns = this.turns.filter(
      (t) => t.completedAt != null,
    ) as unknown as ReadonlyArray<TurnRecord>;

    return computeSummaryEligibility(
      completedTurns,
      this.rollingSummary,
      effectivePolicy,
      estimatedPromptTokens,
      availableInputBudget,
    );
  }

  /**
   * Return completed turn IDs that the rolling summary already covers.
   * The PromptBuilder uses this to exclude summarized turns from raw
   * inclusion.
   */
  getSummaryCoveredTurnIds(): ReadonlySet<string> {
    return new Set(this.rollingSummary?.coveredTurnIds ?? []);
  }

  recordInvokedSkill(record: InvokedSkillRecord): void {
    this.invokedSkills.push(cloneInvokedSkillRecord(record));
  }

  // -------------------------------------------------------------------
  // Pinned memory (Phase 7)
  // -------------------------------------------------------------------

  /**
   * Pin a new fact, constraint, or decision as durable memory.
   * Validates content guardrails and rejects duplicates.
   * Returns the newly created record's ID.
   */
  pinFact(input: PinFactInput): string {
    validatePinInput(input);

    if (
      isDuplicateActive(
        this.pinnedMemory,
        input.kind,
        input.scope ?? "session",
        input.content,
      )
    ) {
      throw new MemoryValidationError(
        "Duplicate active record with the same kind, scope, and content",
      );
    }

    const now = new Date().toISOString();
    const record: PinnedMemoryRecord = {
      id: randomUUID(),
      kind: input.kind,
      scope: input.scope ?? "session",
      content: input.content,
      source: { ...input.source },
      rationale: input.rationale,
      createdAt: now,
      updatedAt: now,
      lifecycle: "active",
    };

    this.pinnedMemory.push(record);
    return record.id;
  }

  /**
   * Convenience wrapper: pin a project-scoped constraint.
   */
  addProjectConstraint(
    content: string,
    source: PinFactInput["source"],
    rationale?: string,
  ): string {
    return this.pinFact({
      kind: "constraint",
      scope: "project",
      content,
      source,
      rationale,
    });
  }

  /**
   * Update an existing pinned memory record. Creates a replacement
   * record and marks the original as superseded. Returns the new
   * record's ID.
   */
  updateMemory(id: string, input: UpdateMemoryInput): string {
    validateUpdateInput(input);

    const idx = this.pinnedMemory.findIndex((r) => r.id === id);
    if (idx === -1) {
      throw new MemoryValidationError(
        `No pinned memory record with id "${id}"`,
      );
    }

    const existing = this.pinnedMemory[idx];
    if (existing.lifecycle !== "active") {
      throw new MemoryValidationError(
        `Cannot update record "${id}": lifecycle is "${existing.lifecycle}"`,
      );
    }

    const newContent = input.content ?? existing.content;
    const newRationale = input.rationale ?? existing.rationale;

    if (
      input.content !== undefined &&
      isDuplicateActive(
        this.pinnedMemory,
        existing.kind,
        existing.scope,
        newContent,
      )
    ) {
      const normalized = newContent.trim().toLowerCase().replace(/\s+/g, " ");
      const existingNormalized = existing.content
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
      if (normalized !== existingNormalized) {
        throw new MemoryValidationError(
          "Updated content duplicates an existing active record",
        );
      }
    }

    const now = new Date().toISOString();
    const replacement: PinnedMemoryRecord = {
      id: randomUUID(),
      kind: existing.kind,
      scope: existing.scope,
      content: newContent,
      source: { ...existing.source },
      rationale: newRationale,
      createdAt: now,
      updatedAt: now,
      lifecycle: "active",
    };

    this.pinnedMemory[idx] = supersedRecord(existing, replacement.id);
    this.pinnedMemory.push(replacement);
    return replacement.id;
  }

  /**
   * Unpin a memory record. Marks it as removed; it no longer appears
   * in prompt output but remains in the inspectable history.
   */
  unpinFact(id: string, rationale?: string): void {
    const idx = this.pinnedMemory.findIndex((r) => r.id === id);
    if (idx === -1) {
      throw new MemoryValidationError(
        `No pinned memory record with id "${id}"`,
      );
    }

    const existing = this.pinnedMemory[idx];
    if (existing.lifecycle !== "active") {
      throw new MemoryValidationError(
        `Cannot unpin record "${id}": lifecycle is "${existing.lifecycle}"`,
      );
    }

    this.pinnedMemory[idx] = removeRecord(existing, rationale);
  }

  /**
   * Retrieve pinned memory records. By default returns only active
   * records. Pass `includeInactive: true` for the full audit trail.
   */
  getPinnedMemory(opts?: {
    includeInactive?: boolean;
  }): ReadonlyArray<PinnedMemoryRecord> {
    const records = opts?.includeInactive
      ? this.pinnedMemory
      : this.pinnedMemory.filter((r) => r.lifecycle === "active");
    return records.map(clonePinnedRecord);
  }

  // -------------------------------------------------------------------
  // Prompt assembly
  // -------------------------------------------------------------------

  private readonly promptBuilder = new PromptBuilder();

  /**
   * Build the prompt plan to send to the provider. Delegates to
   * PromptBuilder for budget-aware assembly and retry support.
   *
   * By default, sources the rolling summary from stored state. The
   * `rollingSummary` option is for test/internal override only.
   *
   * @param systemPrompt - System prompt text
   * @param extraUserInstruction - Optional extra user message appended at the end
   * @param options - Optional overrides for budget policy, context window, retry level, and rolling summary
   */
  buildPromptPlan(
    systemPrompt: string,
    extraUserInstruction?: string,
    options?: {
      contextWindowTokens?: number;
      policy?: PromptBudgetPolicy;
      retryLevel?: number;
      rollingSummary?: string;
      summaryPolicy?: SummaryPolicy;
    },
  ): PromptPlan {
    const policy = options?.policy ?? DEFAULT_BUDGET_POLICY;
    const contextWindow = options?.contextWindowTokens ?? 1_000_000;

    const summaryContent =
      options?.rollingSummary ?? this.rollingSummary?.content;
    const coveredTurnIds = this.getSummaryCoveredTurnIds();

    const pinnedMemoryBlock = renderPinnedMemoryBlock(this.pinnedMemory);

    const request: PromptBuildRequest = {
      systemPrompt,
      pinnedMemoryBlock,
      invokedSkillsBlock: renderInvokedSkillBlock(this.invokedSkills),
      conversationState: {
        preamble: this.preTurnMessages,
        turns: this.turns as unknown as ReadonlyArray<TurnRecord>,
        artifacts: Array.from(this.artifacts.values()) as ArtifactRecord[],
        rollingSummary: this.rollingSummary,
        pinnedMemory: this.pinnedMemory,
        invokedSkills: this.invokedSkills,
      },
      contextWindowTokens: contextWindow,
      policy,
      extraUserInstruction,
      rollingSummary: summaryContent,
      rollingSummarySections: this.rollingSummary?.sections,
      summaryCoveredTurnIds: coveredTurnIds,
      retryLevel: options?.retryLevel,
      artifactLookup: (id: string) => this.artifacts.get(id),
      isCurrentTurnUnresolved: (turnId: string) => {
        const turn = this.turns.find((t) => t.id === turnId);
        return turn != null && !turn.completedAt;
      },
    };

    return this.promptBuilder.buildPlan(request);
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private currentTurn(): MutableTurnRecord | undefined {
    return this.turns.length > 0
      ? this.turns[this.turns.length - 1]
      : undefined;
  }

  private completeTurn(turn: MutableTurnRecord): void {
    turn.completedAt = new Date().toISOString();
    let totalChars = messageChars(turn.userMessage);
    for (const entry of turn.entries) {
      totalChars += messageChars(entry.message);
    }
    turn.estimatedTokens = estimateTokens(totalChars);
  }
}
