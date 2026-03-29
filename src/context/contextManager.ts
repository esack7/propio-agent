import { randomUUID } from "crypto";
import { ChatMessage, ChatToolCall, ToolResult } from "../providers/types.js";
import {
  estimateTokens,
  measureMessages,
  RESERVED_OUTPUT_TOKENS,
} from "../diagnostics.js";
import {
  PromptPlan,
  TurnEntry,
  TurnRecord,
  ConversationState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal mutable counterparts of the public readonly types.  The public
// API returns deep-cloned readonly data; internally we mutate freely.
// ---------------------------------------------------------------------------

interface MutableTurnEntry {
  kind: "assistant" | "tool";
  createdAt: string;
  estimatedTokens?: number;
  message: ChatMessage;
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

function cloneEntry(entry: MutableTurnEntry): TurnEntry {
  return {
    kind: entry.kind,
    createdAt: entry.createdAt,
    estimatedTokens: entry.estimatedTokens,
    message: cloneMessage(entry.message),
  } as TurnEntry;
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
 * Phase 2 stores the canonical conversation as structured TurnRecord[] while
 * preserving all Phase 1 external behavior.  Provider payloads, tool-context
 * snapshots, and public Agent APIs continue to receive flat ChatMessage[]
 * via getSnapshot() and buildPromptPlan().
 *
 * Metadata fields (completedAt, estimatedTokens, importance) are
 * informational only in this phase; they do not alter runtime behavior.
 *
 * Tool results are committed in provider tool-call order.  The API assumes
 * the current sequential execution model; it does not promise concurrent
 * mutation safety.
 */
export class ContextManager {
  /**
   * Messages recorded before any turn exists.  This preserves Phase 1
   * semantics: callers that commit assistant/tool messages without a
   * preceding beginUserTurn() get exactly those messages in getSnapshot()
   * and messageCount — no phantom user message is injected.
   */
  private preTurnMessages: ChatMessage[] = [];

  private turns: MutableTurnRecord[] = [];

  // -------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------

  /**
   * Record the start of a new user turn by creating a TurnRecord.
   */
  beginUserTurn(userMessage: string): void {
    this.turns.push({
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      importance: "normal",
      userMessage: { role: "user", content: userMessage },
      entries: [],
    });
  }

  /**
   * Commit an assistant response (with optional tool calls) for the current
   * iteration.  Called once per provider streaming round.
   *
   * When committed without tool calls the active turn is marked complete
   * and its aggregate token estimate is calculated.
   */
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
   * Record one or more tool results as a single batched tool message.
   * Results must already be ordered to match provider tool-call order.
   */
  recordToolResults(results: ToolResult[]): void {
    const message: ChatMessage = {
      role: "tool",
      content: "",
      toolResults: results,
    };

    const turn = this.currentTurn();
    if (!turn) {
      this.preTurnMessages.push(message);
      return;
    }

    turn.entries.push({
      kind: "tool",
      createdAt: new Date().toISOString(),
      estimatedTokens: estimateTokens(messageChars(message)),
      message,
    });
  }

  /**
   * Remove the latest assistant message only if it contains unresolved
   * tool calls (i.e. tool calls with no matching tool-result following).
   * Used by the no-tools fallback to prevent the model from looping on
   * dangling tool-call messages.
   *
   * When turns exist the check targets the last entry in the last turn.
   * When no turns exist it falls back to the pre-turn messages buffer.
   */
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

  /**
   * Reset all structured state to empty.
   */
  clear(): void {
    this.preTurnMessages = [];
    this.turns = [];
  }

  // -------------------------------------------------------------------
  // Read APIs
  // -------------------------------------------------------------------

  /**
   * Return a deep-cloned copy of the stored messages in flat chronological
   * order.  Callers cannot mutate internal state through the returned
   * objects.  The ordering is identical to the Phase 1 flat array.
   */
  getSnapshot(): ChatMessage[] {
    const messages: ChatMessage[] =
      this.preTurnMessages.map(cloneMessage);
    for (const turn of this.turns) {
      messages.push(cloneMessage(turn.userMessage));
      for (const entry of turn.entries) {
        messages.push(cloneMessage(entry.message));
      }
    }
    return messages;
  }

  /**
   * Return the number of stored messages (pre-turn messages + user
   * messages + entries).
   */
  get messageCount(): number {
    let count = this.preTurnMessages.length;
    for (const turn of this.turns) {
      count += 1 + turn.entries.length;
    }
    return count;
  }

  /**
   * Return deep-cloned readonly structured conversation state.
   * Internal-only API for tests and future consumers.
   *
   * The returned state is full-fidelity: preamble + turns represent
   * the same logical content as getSnapshot().
   */
  getConversationState(): ConversationState {
    return {
      preamble: this.preTurnMessages.map(cloneMessage),
      turns: this.turns.map(cloneTurn),
    };
  }

  // -------------------------------------------------------------------
  // Prompt assembly
  // -------------------------------------------------------------------

  /**
   * Build the prompt messages array to send to the provider.
   *
   * Assembles systemPrompt + pre-turn messages + flattened turns, and
   * optionally appends an extra user instruction (used by the no-tools
   * fallback).  Returns estimated metrics derived from the existing
   * chars/4 heuristic.
   */
  buildPromptPlan(
    systemPrompt: string,
    extraUserInstruction?: string,
  ): PromptPlan {
    const assembled: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.preTurnMessages,
    ];

    for (const turn of this.turns) {
      assembled.push(turn.userMessage);
      for (const entry of turn.entries) {
        assembled.push(entry.message);
      }
    }

    if (extraUserInstruction) {
      assembled.push({ role: "user", content: extraUserInstruction });
    }

    const metrics = measureMessages(assembled);

    return {
      messages: assembled,
      estimatedPromptTokens: metrics.estimatedTokens,
      reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
    };
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
