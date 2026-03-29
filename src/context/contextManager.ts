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
  TurnEntry,
  TurnRecord,
  ConversationState,
  ArtifactRecord,
  ToolInvocationRecord,
  ArtifactToolResult,
} from "./types.js";
import { PromptBuilder, PromptBuildRequest } from "./promptBuilder.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUMMARY_MAX_CHARS = 1500;
const REHYDRATION_MAX_CHARS = 12000;

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

  commitAssistantResponse(content: string, toolCalls?: ChatToolCall[]): void {
    const message: ChatMessage = { role: "assistant", content, toolCalls };

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
          ? generateTextSummary(result.rawContent)
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
      if (this.preTurnMessages.length === 0) {
        return;
      }
      const last = this.preTurnMessages[this.preTurnMessages.length - 1];
      if (
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
    const last = turn.entries[turn.entries.length - 1];
    if (
      last.kind === "assistant" &&
      last.message.toolCalls &&
      last.message.toolCalls.length > 0
    ) {
      turn.entries.pop();
    }
  }

  clear(): void {
    this.preTurnMessages = [];
    this.turns = [];
    this.artifacts.clear();
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
    };
  }

  // -------------------------------------------------------------------
  // Prompt assembly
  // -------------------------------------------------------------------

  private readonly promptBuilder = new PromptBuilder();

  /**
   * Build the prompt plan to send to the provider. Delegates to
   * PromptBuilder for budget-aware assembly and retry support.
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
    },
  ): PromptPlan {
    const policy = options?.policy ?? DEFAULT_BUDGET_POLICY;
    const contextWindow = options?.contextWindowTokens ?? 1_000_000;

    const request: PromptBuildRequest = {
      systemPrompt,
      conversationState: {
        preamble: this.preTurnMessages,
        turns: this.turns as unknown as ReadonlyArray<TurnRecord>,
        artifacts: Array.from(this.artifacts.values()) as ArtifactRecord[],
      },
      contextWindowTokens: contextWindow,
      policy,
      extraUserInstruction,
      rollingSummary: options?.rollingSummary,
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
