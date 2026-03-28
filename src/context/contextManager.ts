import { ChatMessage, ChatToolCall, ToolResult } from "../providers/types.js";
import { measureMessages, RESERVED_OUTPUT_TOKENS } from "../diagnostics.js";
import { PromptPlan } from "./types.js";

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

/**
 * ContextManager owns conversational state for an Agent session.
 *
 * Phase 1 keeps the canonical store as a flat ChatMessage[] and exposes
 * mutation methods so the Agent loop never pushes directly into a raw array.
 * This is a behavior-preserving extraction; provider payloads, tool context
 * snapshots, and public Agent APIs remain unchanged.
 *
 * Tool results are committed in provider tool-call order. The API assumes
 * the current sequential execution model; it does not promise concurrent
 * mutation safety.
 */
export class ContextManager {
  private messages: ChatMessage[] = [];

  /**
   * Record the start of a new user turn by appending a user message.
   */
  beginUserTurn(userMessage: string): void {
    this.messages.push({ role: "user", content: userMessage });
  }

  /**
   * Commit an assistant response (with optional tool calls) for the current
   * iteration. Called once per provider streaming round.
   */
  commitAssistantResponse(content: string, toolCalls?: ChatToolCall[]): void {
    this.messages.push({
      role: "assistant",
      content,
      toolCalls,
    });
  }

  /**
   * Record one or more tool results as a single batched tool message.
   * Results must already be ordered to match provider tool-call order.
   */
  recordToolResults(results: ToolResult[]): void {
    this.messages.push({
      role: "tool",
      content: "",
      toolResults: results,
    });
  }

  /**
   * Remove the latest assistant message only if it contains unresolved tool
   * calls (i.e. tool calls with no matching tool-result message following it).
   * Used by the no-tools fallback to prevent the model from looping on
   * dangling tool-call messages.
   */
  removeLastUnresolvedAssistantMessage(): void {
    if (this.messages.length === 0) {
      return;
    }
    const last = this.messages[this.messages.length - 1];
    if (
      last.role === "assistant" &&
      last.toolCalls &&
      last.toolCalls.length > 0
    ) {
      this.messages.pop();
    }
  }

  /**
   * Reset stored context to empty.
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * Return a deep-cloned copy of the stored messages.
   * Callers cannot mutate internal state through the returned objects.
   */
  getSnapshot(): ChatMessage[] {
    return this.messages.map(cloneMessage);
  }

  /**
   * Return the number of stored messages.
   */
  get messageCount(): number {
    return this.messages.length;
  }

  /**
   * Build the prompt messages array to send to the provider.
   *
   * Assembles systemPrompt + stored messages, and optionally appends an
   * extra user instruction (used by the no-tools fallback). Returns estimated
   * metrics derived from the existing chars/4 heuristic.
   */
  buildPromptPlan(
    systemPrompt: string,
    extraUserInstruction?: string,
  ): PromptPlan {
    const assembled: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.messages,
    ];

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
}
