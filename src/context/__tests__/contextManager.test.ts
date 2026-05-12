import { ContextManager } from "../contextManager.js";
import { RESERVED_OUTPUT_TOKENS, estimateTokens } from "../../diagnostics.js";
import {
  ArtifactToolResult,
  RollingSummaryRecord,
  DEFAULT_SUMMARY_POLICY,
} from "../types.js";
import type { PinFactInput } from "../types.js";
import { MemoryValidationError } from "../memoryManager.js";

function toolResult(
  toolCallId: string,
  toolName: string,
  rawContent: string,
  status: "success" | "error" = "success",
): ArtifactToolResult {
  return { toolCallId, toolName, rawContent, status };
}

describe("ContextManager", () => {
  let manager: ContextManager;

  beforeEach(() => {
    manager = new ContextManager();
  });

  // =================================================================
  // Phase 1 behavior-preserving tests
  // =================================================================

  describe("beginUserTurn", () => {
    it("should append a user message", () => {
      manager.beginUserTurn("Hello");
      const snapshot = manager.getSnapshot();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]).toEqual({ role: "user", content: "Hello" });
    });

    it("should append successive user messages", () => {
      manager.beginUserTurn("First");
      manager.commitAssistantResponse("Reply");
      manager.beginUserTurn("Second");
      expect(manager.messageCount).toBe(3);
    });
  });

  describe("getSnapshot and cloning", () => {
    it("should return a defensive copy that is not affected by later mutations", () => {
      manager.beginUserTurn("Hello");
      const snap1 = manager.getSnapshot();
      manager.commitAssistantResponse("World");
      const snap2 = manager.getSnapshot();

      expect(snap1).toHaveLength(1);
      expect(snap2).toHaveLength(2);
    });

    it("should return an empty array when context is empty", () => {
      expect(manager.getSnapshot()).toEqual([]);
    });

    it("should deep-clone message objects so mutations do not leak back", () => {
      manager.beginUserTurn("Original");
      manager.commitAssistantResponse("Reply", [
        { id: "tc-1", function: { name: "tool", arguments: { a: 1 } } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "tool", "result")]);

      const snapshot = manager.getSnapshot();

      snapshot[0].content = "MUTATED";
      snapshot[1].toolCalls![0].function.arguments.a = 999;
      snapshot[2].toolResults![0].content = "MUTATED";

      const fresh = manager.getSnapshot();
      expect(fresh[0].content).toBe("Original");
      expect(fresh[1].toolCalls![0].function.arguments.a).toBe(1);
      expect(fresh[2].toolResults![0].content).toBe("result");
    });

    it("should deep-clone nested tool call arguments", () => {
      manager.commitAssistantResponse("", [
        {
          id: "tc-1",
          function: {
            name: "write",
            arguments: {
              path: "/tmp/f.txt",
              options: { recursive: true, metadata: { owner: "alice" } },
            },
          },
        },
      ]);

      const snapshot = manager.getSnapshot();
      snapshot[0].toolCalls![0].function.arguments.options.recursive = false;
      snapshot[0].toolCalls![0].function.arguments.options.metadata.owner =
        "MUTATED";

      const fresh = manager.getSnapshot();
      expect(fresh[0].toolCalls![0].function.arguments.options.recursive).toBe(
        true,
      );
      expect(
        fresh[0].toolCalls![0].function.arguments.options.metadata.owner,
      ).toBe("alice");
    });
  });

  describe("commitAssistantResponse", () => {
    it("should append an assistant message without tool calls", () => {
      manager.beginUserTurn("Hi");
      manager.commitAssistantResponse("Hello there");

      const snapshot = manager.getSnapshot();
      expect(snapshot).toHaveLength(2);
      expect(snapshot[1]).toEqual({
        role: "assistant",
        content: "Hello there",
        toolCalls: undefined,
      });
    });

    it("should append an assistant message with tool calls", () => {
      manager.beginUserTurn("Read a file");
      const toolCalls = [
        {
          id: "tc-1",
          function: { name: "read", arguments: { path: "foo.txt" } },
        },
      ];
      manager.commitAssistantResponse("Sure", toolCalls);

      const snapshot = manager.getSnapshot();
      expect(snapshot[1].toolCalls).toEqual(toolCalls);
    });
  });

  describe("recordToolResults", () => {
    it("should append a tool message with batched results", () => {
      manager.beginUserTurn("Do something");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "read", arguments: {} } },
        { id: "tc-2", function: { name: "write", arguments: {} } },
      ]);

      manager.recordToolResults([
        toolResult("tc-1", "read", "file content"),
        toolResult("tc-2", "write", "ok"),
      ]);

      const snapshot = manager.getSnapshot();
      expect(snapshot).toHaveLength(3);
      const toolMsg = snapshot[2];
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.content).toBe("");
      expect(toolMsg.toolResults).toHaveLength(2);
      expect(toolMsg.toolResults![0].toolCallId).toBe("tc-1");
      expect(toolMsg.toolResults![1].toolCallId).toBe("tc-2");
    });

    it("should preserve toolCallId alignment with assistant tool calls", () => {
      manager.beginUserTurn("Run tools");
      const toolCalls = [
        { id: "call-a", function: { name: "tool_a", arguments: {} } },
        { id: "call-b", function: { name: "tool_b", arguments: {} } },
      ];
      manager.commitAssistantResponse("", toolCalls);
      manager.recordToolResults([
        toolResult("call-a", "tool_a", "result-a"),
        toolResult("call-b", "tool_b", "result-b"),
      ]);

      const snapshot = manager.getSnapshot();
      const assistantMsg = snapshot[1];
      const toolMsg = snapshot[2];

      expect(assistantMsg.toolCalls![0].id).toBe(
        toolMsg.toolResults![0].toolCallId,
      );
      expect(assistantMsg.toolCalls![1].id).toBe(
        toolMsg.toolResults![1].toolCallId,
      );
    });
  });

  describe("removeLastUnresolvedAssistantMessage", () => {
    it("should remove an assistant message with unresolved tool calls", () => {
      manager.beginUserTurn("Hello");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);

      expect(manager.messageCount).toBe(2);
      manager.removeLastUnresolvedAssistantMessage();
      expect(manager.messageCount).toBe(1);
      expect(manager.getSnapshot()[0].role).toBe("user");
    });

    it("should not remove an assistant message without tool calls", () => {
      manager.beginUserTurn("Hello");
      manager.commitAssistantResponse("Normal reply");

      expect(manager.messageCount).toBe(2);
      manager.removeLastUnresolvedAssistantMessage();
      expect(manager.messageCount).toBe(2);
    });

    it("should not remove an assistant message with empty tool calls array", () => {
      manager.beginUserTurn("Hello");
      manager.commitAssistantResponse("Reply", []);

      expect(manager.messageCount).toBe(2);
      manager.removeLastUnresolvedAssistantMessage();
      expect(manager.messageCount).toBe(2);
    });

    it("should not remove if last message is not assistant", () => {
      manager.beginUserTurn("Hello");
      manager.removeLastUnresolvedAssistantMessage();
      expect(manager.messageCount).toBe(1);
    });

    it("should be a no-op on empty context", () => {
      manager.removeLastUnresolvedAssistantMessage();
      expect(manager.messageCount).toBe(0);
    });
  });

  describe("clear", () => {
    it("should reset stored context to empty", () => {
      manager.beginUserTurn("First");
      manager.commitAssistantResponse("Second");
      manager.beginUserTurn("Third");
      expect(manager.messageCount).toBe(3);

      manager.clear();
      expect(manager.messageCount).toBe(0);
      expect(manager.getSnapshot()).toEqual([]);
    });

    it("should allow new messages after clearing", () => {
      manager.beginUserTurn("Before");
      manager.clear();
      manager.beginUserTurn("After");
      expect(manager.messageCount).toBe(1);
      expect(manager.getSnapshot()[0].content).toBe("After");
    });
  });

  describe("buildPromptPlan", () => {
    it("should produce system-first messages identical to today's format", () => {
      manager.beginUserTurn("What is 2+2?");
      const plan = manager.buildPromptPlan("You are a math tutor.");

      expect(plan.messages).toHaveLength(2);
      expect(plan.messages[0]).toEqual({
        role: "system",
        content: "You are a math tutor.",
      });
      expect(plan.messages[1]).toEqual({
        role: "user",
        content: "What is 2+2?",
      });
    });

    it("should include all stored messages in chronological order", () => {
      manager.beginUserTurn("Hi");
      manager.commitAssistantResponse("Hello");
      manager.beginUserTurn("How are you?");
      manager.commitAssistantResponse("I'm fine");

      const plan = manager.buildPromptPlan("system");
      expect(plan.messages).toHaveLength(5);
      expect(plan.messages.map((m) => m.role)).toEqual([
        "system",
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    });

    it("should append extra user instruction when provided", () => {
      manager.beginUserTurn("Original question");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "tool", "result")]);

      const plan = manager.buildPromptPlan(
        "system",
        "Do not call tools. Answer directly.",
      );

      const lastMsg = plan.messages[plan.messages.length - 1];
      expect(lastMsg.role).toBe("user");
      expect(lastMsg.content).toBe("Do not call tools. Answer directly.");
    });

    it("should not append extra instruction when not provided", () => {
      manager.beginUserTurn("Hello");
      const plan = manager.buildPromptPlan("system");
      expect(plan.messages).toHaveLength(2);
    });

    it("should return correct token estimates", () => {
      manager.beginUserTurn("A short message");
      const plan = manager.buildPromptPlan("Short system prompt");

      expect(plan.estimatedPromptTokens).toBeGreaterThan(0);
      expect(plan.reservedOutputTokens).toBe(RESERVED_OUTPUT_TOKENS);
    });

    it("should produce an empty-context plan with only system message", () => {
      const plan = manager.buildPromptPlan("system");
      expect(plan.messages).toHaveLength(1);
      expect(plan.messages[0].role).toBe("system");
    });
  });

  describe("messageCount", () => {
    it("should track message count accurately", () => {
      expect(manager.messageCount).toBe(0);
      manager.beginUserTurn("A");
      expect(manager.messageCount).toBe(1);
      manager.commitAssistantResponse("B");
      expect(manager.messageCount).toBe(2);
      manager.recordToolResults([toolResult("tc", "t", "r")]);
      expect(manager.messageCount).toBe(3);
    });
  });

  describe("pre-turn messages (backward compatibility)", () => {
    it("should not inject a phantom user message when commitAssistantResponse is called without beginUserTurn", () => {
      manager.commitAssistantResponse("Orphan reply");

      const snapshot = manager.getSnapshot();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].role).toBe("assistant");
      expect(snapshot[0].content).toBe("Orphan reply");
      expect(manager.messageCount).toBe(1);
    });

    it("should not inject a phantom user message when recordToolResults is called without beginUserTurn", () => {
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "tool", "result")]);

      const snapshot = manager.getSnapshot();
      expect(snapshot).toHaveLength(2);
      expect(snapshot[0].role).toBe("assistant");
      expect(snapshot[1].role).toBe("tool");
      expect(manager.messageCount).toBe(2);
    });

    it("should allow removeLastUnresolvedAssistantMessage on pre-turn messages", () => {
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);
      expect(manager.messageCount).toBe(1);

      manager.removeLastUnresolvedAssistantMessage();
      expect(manager.messageCount).toBe(0);
      expect(manager.getSnapshot()).toEqual([]);
    });

    it("should include pre-turn messages in buildPromptPlan", () => {
      manager.commitAssistantResponse("Early reply");
      manager.beginUserTurn("Later question");

      const plan = manager.buildPromptPlan("system");
      expect(plan.messages).toHaveLength(3);
      expect(plan.messages[0].role).toBe("system");
      expect(plan.messages[1].role).toBe("assistant");
      expect(plan.messages[1].content).toBe("Early reply");
      expect(plan.messages[2].role).toBe("user");
      expect(plan.messages[2].content).toBe("Later question");
    });

    it("should clear pre-turn messages along with turns", () => {
      manager.commitAssistantResponse("Orphan");
      manager.beginUserTurn("User");
      manager.commitAssistantResponse("Reply");
      expect(manager.messageCount).toBe(3);

      manager.clear();
      expect(manager.messageCount).toBe(0);
      expect(manager.getSnapshot()).toEqual([]);
    });

    it("should surface pre-turn messages in getConversationState().preamble", () => {
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "tool", "result")]);

      const state = manager.getConversationState();
      expect(state.preamble).toHaveLength(2);
      expect(state.preamble[0].role).toBe("assistant");
      expect(state.preamble[1].role).toBe("tool");
      expect(state.turns).toEqual([]);
    });

    it("should deep-clone preamble so mutations do not leak back", () => {
      manager.commitAssistantResponse("Original");

      const state1 = manager.getConversationState();
      (state1.preamble[0] as any).content = "MUTATED";

      const state2 = manager.getConversationState();
      expect(state2.preamble[0].content).toBe("Original");
    });

    it("should represent the same content in getConversationState as in getSnapshot", () => {
      manager.commitAssistantResponse("Pre-turn msg");
      manager.beginUserTurn("User msg");
      manager.commitAssistantResponse("Reply", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "tool", "ok")]);
      manager.commitAssistantResponse("Final");

      const snapshot = manager.getSnapshot();
      const state = manager.getConversationState();

      const flatFromState: string[] = [
        ...state.preamble.map((m) => m.role),
        ...state.turns.flatMap((t) => [
          t.userMessage.role,
          ...t.entries.map((e) => e.message.role),
        ]),
      ];
      expect(flatFromState).toEqual(snapshot.map((m) => m.role));
    });
  });

  // =================================================================
  // Phase 2 turn-based storage tests
  // =================================================================

  describe("getConversationState", () => {
    it("should return empty preamble, turns, and artifacts for a new manager", () => {
      const state = manager.getConversationState();
      expect(state.preamble).toEqual([]);
      expect(state.turns).toEqual([]);
      expect(state.artifacts).toEqual([]);
    });

    it("should create one TurnRecord per user prompt", () => {
      manager.beginUserTurn("First");
      manager.commitAssistantResponse("Reply 1");
      manager.beginUserTurn("Second");
      manager.commitAssistantResponse("Reply 2");

      const state = manager.getConversationState();
      expect(state.preamble).toEqual([]);
      expect(state.turns).toHaveLength(2);
      expect(state.turns[0].userMessage.content).toBe("First");
      expect(state.turns[1].userMessage.content).toBe("Second");
    });

    it("should return a deep-cloned copy that cannot mutate internal state", () => {
      manager.beginUserTurn("Hello");
      manager.commitAssistantResponse("World");

      const state1 = manager.getConversationState();
      (state1.turns[0] as any).importance = "high";
      (state1.turns[0].entries[0] as any).message.content = "MUTATED";

      const state2 = manager.getConversationState();
      expect(state2.turns[0].importance).toBe("normal");
      expect(state2.turns[0].entries[0].message.content).toBe("World");
    });
  });

  describe("turn structure", () => {
    it("should store a plain user/assistant turn as one turn with one entry", () => {
      manager.beginUserTurn("Hello");
      manager.commitAssistantResponse("Hi there");

      const state = manager.getConversationState();
      expect(state.turns).toHaveLength(1);
      const turn = state.turns[0];
      expect(turn.userMessage.content).toBe("Hello");
      expect(turn.entries).toHaveLength(1);
      expect(turn.entries[0].kind).toBe("assistant");
      expect(turn.entries[0].message.content).toBe("Hi there");
    });

    it("should store a tool-calling turn with multiple ordered entries", () => {
      manager.beginUserTurn("List files");
      manager.commitAssistantResponse("Sure", [
        { id: "tc-1", function: { name: "ls", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "ls", "file.txt")]);
      manager.commitAssistantResponse("Found file.txt");

      const state = manager.getConversationState();
      expect(state.turns).toHaveLength(1);
      const turn = state.turns[0];
      expect(turn.entries).toHaveLength(3);
      expect(turn.entries[0].kind).toBe("assistant");
      expect(turn.entries[1].kind).toBe("tool");
      expect(turn.entries[2].kind).toBe("assistant");
    });

    it("should store multi-iteration tool loops as one turn with many entries", () => {
      manager.beginUserTurn("Complex task");

      manager.commitAssistantResponse("Step 1", [
        { id: "tc-1", function: { name: "read", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "read", "data1")]);

      manager.commitAssistantResponse("Step 2", [
        { id: "tc-2", function: { name: "write", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-2", "write", "ok")]);

      manager.commitAssistantResponse("All done");

      const state = manager.getConversationState();
      expect(state.turns).toHaveLength(1);
      const turn = state.turns[0];
      expect(turn.entries).toHaveLength(5);
      expect(turn.entries.map((e) => e.kind)).toEqual([
        "assistant",
        "tool",
        "assistant",
        "tool",
        "assistant",
      ]);
    });

    it("should produce identical flattened snapshot for plain turns", () => {
      manager.beginUserTurn("Hello");
      manager.commitAssistantResponse("Hi");
      manager.beginUserTurn("Bye");
      manager.commitAssistantResponse("Goodbye");

      const snapshot = manager.getSnapshot();
      expect(snapshot.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(snapshot[0].content).toBe("Hello");
      expect(snapshot[1].content).toBe("Hi");
      expect(snapshot[2].content).toBe("Bye");
      expect(snapshot[3].content).toBe("Goodbye");
    });

    it("should produce identical flattened snapshot for tool-calling turns", () => {
      manager.beginUserTurn("Do it");
      manager.commitAssistantResponse("OK", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "tool", "result")]);
      manager.commitAssistantResponse("Done");

      const snapshot = manager.getSnapshot();
      expect(snapshot.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ]);
    });
  });

  describe("removeLastUnresolvedAssistantMessage (turn-aware)", () => {
    it("should remove only the trailing unresolved assistant entry and leave earlier entries intact", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("Step 1", [
        { id: "tc-1", function: { name: "read", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "read", "data")]);
      manager.commitAssistantResponse("Step 2", [
        { id: "tc-2", function: { name: "write", arguments: {} } },
      ]);

      const state = manager.getConversationState();
      expect(state.turns[0].entries).toHaveLength(3);

      manager.removeLastUnresolvedAssistantMessage();

      const stateAfter = manager.getConversationState();
      expect(stateAfter.turns[0].entries).toHaveLength(2);
      expect(stateAfter.turns[0].entries[0].kind).toBe("assistant");
      expect(stateAfter.turns[0].entries[1].kind).toBe("tool");
    });

    it("should not remove when last entry is a tool result", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("Call", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "ok")]);

      manager.removeLastUnresolvedAssistantMessage();

      const state = manager.getConversationState();
      expect(state.turns[0].entries).toHaveLength(2);
    });
  });

  describe("turn completion (completedAt)", () => {
    it("should leave completedAt unset during an in-progress turn", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("Working", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "tool", "ok")]);

      const state = manager.getConversationState();
      expect(state.turns[0].completedAt).toBeUndefined();
    });

    it("should set completedAt when assistant responds without tool calls", () => {
      manager.beginUserTurn("Hello");
      manager.commitAssistantResponse("Hi there");

      const state = manager.getConversationState();
      expect(state.turns[0].completedAt).toBeDefined();
      expect(typeof state.turns[0].completedAt).toBe("string");
    });

    it("should set completedAt after the final answer following a tool loop", () => {
      manager.beginUserTurn("Complex");
      manager.commitAssistantResponse("Step", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "tool", "ok")]);

      expect(
        manager.getConversationState().turns[0].completedAt,
      ).toBeUndefined();

      manager.commitAssistantResponse("Final answer");

      expect(manager.getConversationState().turns[0].completedAt).toBeDefined();
    });

    it("should set completedAt when final answer comes via no-tools fallback pattern", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "tool", "ok")]);

      manager.commitAssistantResponse("", [
        { id: "tc-2", function: { name: "tool", arguments: {} } },
      ]);
      manager.removeLastUnresolvedAssistantMessage();
      manager.commitAssistantResponse("Fallback answer");

      const state = manager.getConversationState();
      expect(state.turns[0].completedAt).toBeDefined();
    });
  });

  describe("turn and entry token estimates", () => {
    it("should populate estimatedTokens on assistant entries", () => {
      manager.beginUserTurn("Hello");
      manager.commitAssistantResponse("This is a reply");

      const state = manager.getConversationState();
      const entry = state.turns[0].entries[0];
      expect(entry.estimatedTokens).toBeDefined();
      expect(entry.estimatedTokens).toBeGreaterThan(0);
    });

    it("should populate estimatedTokens on tool entries", () => {
      manager.beginUserTurn("Go");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "big result here")]);

      const state = manager.getConversationState();
      const toolEntry = state.turns[0].entries[1];
      expect(toolEntry.kind).toBe("tool");
      expect(toolEntry.estimatedTokens).toBeDefined();
      expect(toolEntry.estimatedTokens).toBeGreaterThan(0);
    });

    it("should populate aggregate estimatedTokens on completed turns", () => {
      manager.beginUserTurn("Some user message");
      manager.commitAssistantResponse("Some reply");

      const state = manager.getConversationState();
      const turn = state.turns[0];
      expect(turn.estimatedTokens).toBeDefined();
      expect(turn.estimatedTokens).toBeGreaterThan(0);
    });

    it("should not populate aggregate estimatedTokens on in-progress turns", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("Working", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);

      const state = manager.getConversationState();
      expect(state.turns[0].estimatedTokens).toBeUndefined();
    });

    it("should use chars/4 heuristic consistent with diagnostics module", () => {
      const content = "A".repeat(100);
      manager.beginUserTurn("Q");
      manager.commitAssistantResponse(content);

      const state = manager.getConversationState();
      const entry = state.turns[0].entries[0];
      expect(entry.estimatedTokens).toBe(estimateTokens(content.length));
    });
  });

  describe("turn metadata", () => {
    it("should assign unique IDs to each turn", () => {
      manager.beginUserTurn("First");
      manager.commitAssistantResponse("R1");
      manager.beginUserTurn("Second");
      manager.commitAssistantResponse("R2");

      const state = manager.getConversationState();
      expect(state.turns[0].id).toBeDefined();
      expect(state.turns[1].id).toBeDefined();
      expect(state.turns[0].id).not.toBe(state.turns[1].id);
    });

    it("should set startedAt on turn creation", () => {
      manager.beginUserTurn("Hello");

      const state = manager.getConversationState();
      expect(state.turns[0].startedAt).toBeDefined();
      expect(new Date(state.turns[0].startedAt).getTime()).not.toBeNaN();
    });

    it("should default importance to normal", () => {
      manager.beginUserTurn("Hello");

      const state = manager.getConversationState();
      expect(state.turns[0].importance).toBe("normal");
    });

    it("should set createdAt timestamps on entries", () => {
      manager.beginUserTurn("Go");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "ok")]);
      manager.commitAssistantResponse("Done");

      const state = manager.getConversationState();
      for (const entry of state.turns[0].entries) {
        expect(entry.createdAt).toBeDefined();
        expect(new Date(entry.createdAt).getTime()).not.toBeNaN();
      }
    });
  });

  describe("clear resets structured state", () => {
    it("should clear all turns and structured metadata", () => {
      manager.beginUserTurn("A");
      manager.commitAssistantResponse("B");
      manager.beginUserTurn("C");
      manager.commitAssistantResponse("D");

      manager.clear();

      const state = manager.getConversationState();
      expect(state.preamble).toEqual([]);
      expect(state.turns).toEqual([]);
      expect(manager.messageCount).toBe(0);
      expect(manager.getSnapshot()).toEqual([]);
    });

    it("should clear preamble and turns together", () => {
      manager.commitAssistantResponse("Orphan");
      manager.beginUserTurn("User");
      manager.commitAssistantResponse("Reply");

      manager.clear();

      const state = manager.getConversationState();
      expect(state.preamble).toEqual([]);
      expect(state.turns).toEqual([]);
    });
  });

  // =================================================================
  // Phase 3 artifact-backed tool output tests
  // =================================================================

  describe("artifact creation", () => {
    it("should create an artifact for each tool result", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "read", arguments: {} } },
        { id: "tc-2", function: { name: "write", arguments: {} } },
      ]);
      manager.recordToolResults([
        toolResult("tc-1", "read", "file contents here"),
        toolResult("tc-2", "write", "ok"),
      ]);

      const state = manager.getConversationState();
      expect(state.artifacts).toHaveLength(2);
      expect(state.artifacts[0].type).toBe("tool_result");
      expect(state.artifacts[0].mediaType).toBe("text/plain");
      expect(state.artifacts[0].content).toBe("file contents here");
      expect(state.artifacts[0].contentSizeChars).toBe(
        "file contents here".length,
      );
      expect(state.artifacts[1].content).toBe("ok");
    });

    it("should assign unique IDs to each artifact", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "a", arguments: {} } },
        { id: "tc-2", function: { name: "b", arguments: {} } },
      ]);
      manager.recordToolResults([
        toolResult("tc-1", "a", "one"),
        toolResult("tc-2", "b", "two"),
      ]);

      const state = manager.getConversationState();
      expect(state.artifacts[0].id).toBeDefined();
      expect(state.artifacts[1].id).toBeDefined();
      expect(state.artifacts[0].id).not.toBe(state.artifacts[1].id);
    });

    it("should set estimatedTokens on artifacts", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "a".repeat(400))]);

      const state = manager.getConversationState();
      expect(state.artifacts[0].estimatedTokens).toBe(estimateTokens(400));
    });

    it("should record the turn ID in artifact referencingTurnIds", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "result")]);

      const state = manager.getConversationState();
      const turnId = state.turns[0].id;
      expect(state.artifacts[0].referencingTurnIds).toContain(turnId);
    });

    it("should create artifacts even for pre-turn tool results", () => {
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "pre-turn result")]);

      const state = manager.getConversationState();
      expect(state.artifacts).toHaveLength(1);
      expect(state.artifacts[0].content).toBe("pre-turn result");
      expect(state.artifacts[0].referencingTurnIds).toEqual([]);
    });

    it("should deep-clone artifacts in getConversationState", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "original")]);

      const state1 = manager.getConversationState();
      (state1.artifacts[0] as any).content = "MUTATED";

      const state2 = manager.getConversationState();
      expect(state2.artifacts[0].content).toBe("original");
    });
  });

  describe("tool invocation records", () => {
    it("should attach toolInvocations to tool entries", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "read", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "read", "file data")]);

      const state = manager.getConversationState();
      const toolEntry = state.turns[0].entries[1];
      expect(toolEntry.kind).toBe("tool");
      if (toolEntry.kind === "tool") {
        expect(toolEntry.toolInvocations).toHaveLength(1);
        expect(toolEntry.toolInvocations[0].toolCallId).toBe("tc-1");
        expect(toolEntry.toolInvocations[0].toolName).toBe("read");
        expect(toolEntry.toolInvocations[0].status).toBe("success");
        expect(toolEntry.toolInvocations[0].artifactId).toBeDefined();
        expect(toolEntry.toolInvocations[0].mediaType).toBe("text/plain");
      }
    });

    it("should record error status in tool invocations", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "read", arguments: {} } },
      ]);
      manager.recordToolResults([
        toolResult("tc-1", "read", "Error: file not found", "error"),
      ]);

      const state = manager.getConversationState();
      const toolEntry = state.turns[0].entries[1];
      if (toolEntry.kind === "tool") {
        expect(toolEntry.toolInvocations[0].status).toBe("error");
      }
    });

    it("should link invocation artifactId to a matching artifact", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "payload")]);

      const state = manager.getConversationState();
      const toolEntry = state.turns[0].entries[1];
      if (toolEntry.kind === "tool") {
        const artifactId = toolEntry.toolInvocations[0].artifactId;
        const artifact = state.artifacts.find((a) => a.id === artifactId);
        expect(artifact).toBeDefined();
        expect(artifact!.content).toBe("payload");
      }
    });

    it("should store contentSizeChars and estimatedTokens on invocations", () => {
      const rawContent = "x".repeat(200);
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", rawContent)]);

      const state = manager.getConversationState();
      const toolEntry = state.turns[0].entries[1];
      if (toolEntry.kind === "tool") {
        expect(toolEntry.toolInvocations[0].contentSizeChars).toBe(200);
        expect(toolEntry.toolInvocations[0].estimatedTokens).toBe(
          estimateTokens(200),
        );
      }
    });
  });

  describe("summary generation", () => {
    it("should use full content as summary for short results", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "short result")]);

      const snapshot = manager.getSnapshot();
      const toolMsg = snapshot[2];
      expect(toolMsg.toolResults![0].content).toBe("short result");
    });

    it("should truncate long success results in the summary", () => {
      const longResult = "x".repeat(5000);
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", longResult)]);

      const snapshot = manager.getSnapshot();
      const summary = snapshot[2].toolResults![0].content;
      expect(summary.length).toBeLessThan(longResult.length);
      expect(summary).toContain("more chars truncated");
    });

    it("should use full content as summary for short error results", () => {
      const shortError = "Error: file not found";
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", shortError, "error")]);

      const snapshot = manager.getSnapshot();
      expect(snapshot[2].toolResults![0].content).toBe(shortError);
    });

    it("should truncate long error results in the summary", () => {
      const longError = "Error: " + "detail ".repeat(500);
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", longError, "error")]);

      const snapshot = manager.getSnapshot();
      const content = snapshot[2].toolResults![0].content;
      expect(content.length).toBeLessThan(longError.length);
      expect(content).toContain("more chars truncated");
    });

    it("should store resultSummary on tool invocation records", () => {
      const longResult = "y".repeat(5000);
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", longResult)]);

      const state = manager.getConversationState();
      const toolEntry = state.turns[0].entries[1];
      if (toolEntry.kind === "tool") {
        const inv = toolEntry.toolInvocations[0];
        expect(inv.resultSummary.length).toBeLessThan(longResult.length);
        expect(inv.resultSummary).toContain("more chars truncated");
      }
    });
  });

  describe("prompt rehydration", () => {
    it("should rehydrate raw artifact content for the current incomplete turn", () => {
      const longResult = "z".repeat(5000);
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", longResult)]);

      const plan = manager.buildPromptPlan("system");
      const toolMsg = plan.messages.find(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.toolResults![0].content).toBe(longResult);
    });

    it("should use summary content for completed turns in the prompt", () => {
      const longResult = "z".repeat(5000);
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", longResult)]);
      manager.commitAssistantResponse("Done");

      const plan = manager.buildPromptPlan("system");
      const toolMsg = plan.messages.find(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsg).toBeDefined();
      const content = toolMsg!.toolResults![0].content;
      expect(content.length).toBeLessThan(longResult.length);
      expect(content).toContain("more chars truncated");
    });

    it("should cap rehydrated content at the rehydration limit", () => {
      const hugeResult = "a".repeat(20000);
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", hugeResult)]);

      const plan = manager.buildPromptPlan("system");
      const toolMsg = plan.messages.find(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsg!.toolResults![0].content.length).toBeLessThan(
        hugeResult.length,
      );
      expect(toolMsg!.toolResults![0].content).toContain("output truncated:");
    });

    it("should rehydrate multiple tool results in the same batch", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "a", arguments: {} } },
        { id: "tc-2", function: { name: "b", arguments: {} } },
      ]);
      manager.recordToolResults([
        toolResult("tc-1", "a", "result-a"),
        toolResult("tc-2", "b", "result-b"),
      ]);

      const plan = manager.buildPromptPlan("system");
      const toolMsg = plan.messages.find(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsg!.toolResults![0].content).toBe("result-a");
      expect(toolMsg!.toolResults![1].content).toBe("result-b");
    });

    it("should rehydrate current turn but summarize earlier completed turns", () => {
      const longResult1 = "x".repeat(5000);
      const longResult2 = "y".repeat(5000);

      // Turn 1: completed
      manager.beginUserTurn("First task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", longResult1)]);
      manager.commitAssistantResponse("First done");

      // Turn 2: still in progress
      manager.beginUserTurn("Second task");
      manager.commitAssistantResponse("", [
        { id: "tc-2", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-2", "t", longResult2)]);

      const plan = manager.buildPromptPlan("system");
      const toolMsgs = plan.messages.filter(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsgs).toHaveLength(2);

      // Turn 1 tool message: summary (completed)
      const turn1Content = toolMsgs[0].toolResults![0].content;
      expect(turn1Content.length).toBeLessThan(longResult1.length);
      expect(turn1Content).toContain("more chars truncated");

      // Turn 2 tool message: rehydrated (current)
      const turn2Content = toolMsgs[1].toolResults![0].content;
      expect(turn2Content).toBe(longResult2);
    });

    it("should only rehydrate trailing unresolved tool results in a multi-iteration loop", () => {
      const iterationOneResult = "a".repeat(5000);
      const iterationTwoResult = "b".repeat(5000);

      manager.beginUserTurn("Complex task");

      // Iteration 1: assistant calls a tool, results come back
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "read", arguments: {} } },
      ]);
      manager.recordToolResults([
        toolResult("tc-1", "read", iterationOneResult),
      ]);

      // Iteration 2: assistant calls another tool (model already saw iteration 1 results)
      manager.commitAssistantResponse("", [
        { id: "tc-2", function: { name: "ls", arguments: { path: "." } } },
      ]);
      manager.recordToolResults([toolResult("tc-2", "ls", iterationTwoResult)]);

      const plan = manager.buildPromptPlan("system");
      const toolMsgs = plan.messages.filter(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsgs).toHaveLength(2);

      // Iteration 1 tool results: summary (resolved — assistant already responded)
      const iter1Content = toolMsgs[0].toolResults![0].content;
      expect(iter1Content.length).toBeLessThan(iterationOneResult.length);
      expect(iter1Content).toContain("more chars truncated");

      // Iteration 2 tool results: rehydrated (unresolved — no follow-up yet)
      const iter2Content = toolMsgs[1].toolResults![0].content;
      expect(iter2Content).toBe(iterationTwoResult);
    });

    it("should summarize all tool results when last entry is assistant in current turn", () => {
      const longResult = "c".repeat(5000);

      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", longResult)]);
      // Assistant responds with more tool calls — previous tool results are resolved
      manager.commitAssistantResponse("", [
        { id: "tc-2", function: { name: "t2", arguments: {} } },
      ]);

      const plan = manager.buildPromptPlan("system");
      const toolMsgs = plan.messages.filter(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsgs).toHaveLength(1);

      // Tool results from before the latest assistant entry: summary
      const content = toolMsgs[0].toolResults![0].content;
      expect(content.length).toBeLessThan(longResult.length);
      expect(content).toContain("more chars truncated");
    });

    it("should handle three-iteration loop correctly", () => {
      const r1 = "x".repeat(5000);
      const r2 = "y".repeat(5000);
      const r3 = "z".repeat(5000);

      manager.beginUserTurn("Long task");

      // Iteration 1
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", r1)]);

      // Iteration 2
      manager.commitAssistantResponse("", [
        { id: "tc-2", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-2", "t", r2)]);

      // Iteration 3
      manager.commitAssistantResponse("", [
        { id: "tc-3", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-3", "t", r3)]);

      const plan = manager.buildPromptPlan("system");
      const toolMsgs = plan.messages.filter(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsgs).toHaveLength(3);

      // Iterations 1 and 2: summarized (resolved)
      expect(toolMsgs[0].toolResults![0].content).toContain(
        "more chars truncated",
      );
      expect(toolMsgs[1].toolResults![0].content).toContain(
        "more chars truncated",
      );

      // Iteration 3: rehydrated (unresolved)
      expect(toolMsgs[2].toolResults![0].content).toBe(r3);
    });
  });

  describe("clear removes artifacts", () => {
    it("should clear artifacts along with turns", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "artifact content")]);

      expect(manager.getConversationState().artifacts).toHaveLength(1);

      manager.clear();

      expect(manager.getConversationState().artifacts).toEqual([]);
    });

    it("should allow new artifacts after clearing", () => {
      manager.beginUserTurn("Task 1");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "first")]);

      manager.clear();

      manager.beginUserTurn("Task 2");
      manager.commitAssistantResponse("", [
        { id: "tc-2", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-2", "t", "second")]);

      const state = manager.getConversationState();
      expect(state.artifacts).toHaveLength(1);
      expect(state.artifacts[0].content).toBe("second");
    });
  });

  describe("media-type-aware artifact ingestion", () => {
    it("should default to text/plain for string content", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "text content")]);

      const state = manager.getConversationState();
      expect(state.artifacts[0].mediaType).toBe("text/plain");
    });

    it("should default to application/octet-stream for Uint8Array content", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([
        {
          toolCallId: "tc-1",
          toolName: "t",
          rawContent: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          status: "success" as const,
        },
      ]);

      const state = manager.getConversationState();
      expect(state.artifacts[0].mediaType).toBe("application/octet-stream");
      expect(state.artifacts[0].content).toBeInstanceOf(Uint8Array);
    });

    it("should use caller-supplied mediaType when provided", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([
        {
          toolCallId: "tc-1",
          toolName: "t",
          rawContent: new Uint8Array([0xff, 0xd8, 0xff]),
          mediaType: "image/jpeg",
          status: "success" as const,
        },
      ]);

      const state = manager.getConversationState();
      expect(state.artifacts[0].mediaType).toBe("image/jpeg");
      const toolEntry = state.turns[0].entries[1];
      if (toolEntry.kind === "tool") {
        expect(toolEntry.toolInvocations[0].mediaType).toBe("image/jpeg");
      }
    });

    it("should generate a descriptive summary for binary artifacts", () => {
      const binaryData = new Uint8Array(2048);
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([
        {
          toolCallId: "tc-1",
          toolName: "t",
          rawContent: binaryData,
          mediaType: "image/png",
          status: "success" as const,
        },
      ]);

      const snapshot = manager.getSnapshot();
      const summary = snapshot[2].toolResults![0].content;
      expect(summary).toContain("binary content");
      expect(summary).toContain("2048 bytes");
      expect(summary).toContain("image/png");
    });

    it("should store contentSizeChars as byte length for binary artifacts", () => {
      const data = new Uint8Array(512);
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([
        {
          toolCallId: "tc-1",
          toolName: "t",
          rawContent: data,
          status: "success" as const,
        },
      ]);

      const state = manager.getConversationState();
      expect(state.artifacts[0].contentSizeChars).toBe(512);
    });

    it("should not rehydrate binary artifacts into prompt messages", () => {
      const binaryData = new Uint8Array([1, 2, 3]);
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([
        {
          toolCallId: "tc-1",
          toolName: "t",
          rawContent: binaryData,
          mediaType: "image/png",
          status: "success" as const,
        },
      ]);

      const plan = manager.buildPromptPlan("system");
      const toolMsg = plan.messages.find(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsg!.toolResults![0].content).toContain("binary content");
    });
  });

  describe("multi-tool batch ordering", () => {
    it("should preserve tool-call/tool-result ID alignment through artifacts", () => {
      manager.beginUserTurn("Run tools");
      const toolCalls = [
        { id: "call-a", function: { name: "tool_a", arguments: {} } },
        { id: "call-b", function: { name: "tool_b", arguments: {} } },
      ];
      manager.commitAssistantResponse("", toolCalls);
      manager.recordToolResults([
        toolResult("call-a", "tool_a", "result-a"),
        toolResult("call-b", "tool_b", "result-b"),
      ]);

      const plan = manager.buildPromptPlan("system");
      const assistantMsg = plan.messages.find(
        (m) => m.role === "assistant" && m.toolCalls?.length,
      );
      const toolMsg = plan.messages.find(
        (m) => m.role === "tool" && m.toolResults?.length,
      );

      expect(assistantMsg!.toolCalls![0].id).toBe(
        toolMsg!.toolResults![0].toolCallId,
      );
      expect(assistantMsg!.toolCalls![1].id).toBe(
        toolMsg!.toolResults![1].toolCallId,
      );
    });
  });

  // =================================================================
  // Phase 5 rolling summary tests
  // =================================================================

  describe("rolling summary state", () => {
    it("should start with no rolling summary", () => {
      expect(manager.getRollingSummary()).toBeUndefined();
      expect(manager.getConversationState().rollingSummary).toBeUndefined();
    });

    it("should store and retrieve a rolling summary", () => {
      const summary: RollingSummaryRecord = {
        content: "User discussed file operations",
        updatedAt: "2026-01-01T00:10:00Z",
        coveredTurnIds: ["t1", "t2"],
        estimatedTokens: 10,
      };

      manager.setRollingSummary(summary);

      const stored = manager.getRollingSummary();
      expect(stored).toBeDefined();
      expect(stored!.content).toBe("User discussed file operations");
      expect(stored!.coveredTurnIds).toEqual(["t1", "t2"]);
    });

    it("should deep-clone rolling summary so mutations do not leak back", () => {
      const summary: RollingSummaryRecord = {
        content: "Original",
        updatedAt: "2026-01-01T00:10:00Z",
        coveredTurnIds: ["t1"],
        estimatedTokens: 5,
      };

      manager.setRollingSummary(summary);

      const retrieved = manager.getRollingSummary()!;
      (retrieved as any).content = "MUTATED";
      (retrieved.coveredTurnIds as any).push("t99");

      const fresh = manager.getRollingSummary()!;
      expect(fresh.content).toBe("Original");
      expect(fresh.coveredTurnIds).toEqual(["t1"]);
    });

    it("should include rolling summary in getConversationState", () => {
      const summary: RollingSummaryRecord = {
        content: "Summary text",
        updatedAt: "2026-01-01T00:10:00Z",
        coveredTurnIds: ["t1"],
        estimatedTokens: 5,
      };

      manager.setRollingSummary(summary);

      const state = manager.getConversationState();
      expect(state.rollingSummary).toBeDefined();
      expect(state.rollingSummary!.content).toBe("Summary text");
    });

    it("should atomically replace the rolling summary", () => {
      manager.setRollingSummary({
        content: "First",
        updatedAt: "2026-01-01T00:10:00Z",
        coveredTurnIds: ["t1"],
        estimatedTokens: 5,
      });

      manager.setRollingSummary({
        content: "Second",
        updatedAt: "2026-01-01T00:20:00Z",
        coveredTurnIds: ["t1", "t2"],
        estimatedTokens: 8,
      });

      const stored = manager.getRollingSummary()!;
      expect(stored.content).toBe("Second");
      expect(stored.coveredTurnIds).toEqual(["t1", "t2"]);
    });

    it("should clear rolling summary on context clear", () => {
      manager.setRollingSummary({
        content: "Summary",
        updatedAt: "2026-01-01T00:10:00Z",
        coveredTurnIds: ["t1"],
        estimatedTokens: 5,
      });

      manager.clear();

      expect(manager.getRollingSummary()).toBeUndefined();
      expect(manager.getConversationState().rollingSummary).toBeUndefined();
    });
  });

  describe("summary eligibility", () => {
    it("should return no eligibility with fewer than rawRecentTurns completed", () => {
      for (let i = 0; i < 4; i++) {
        manager.beginUserTurn(`msg ${i}`);
        manager.commitAssistantResponse(`reply ${i}`);
      }

      const eligibility = manager.getSummaryEligibility();
      expect(eligibility.shouldRefresh).toBe(false);
      expect(eligibility.eligibleTurns).toHaveLength(0);
    });

    it("should identify eligible turns beyond recent window", () => {
      for (let i = 0; i < 10; i++) {
        manager.beginUserTurn(`msg ${i}`);
        manager.commitAssistantResponse(`reply ${i}`);
      }

      const eligibility = manager.getSummaryEligibility();
      expect(eligibility.eligibleTurns.length).toBeGreaterThan(0);
      expect(eligibility.shouldRefresh).toBe(true);
    });

    it("should track new eligible count against stored summary", () => {
      for (let i = 0; i < 10; i++) {
        manager.beginUserTurn(`msg ${i}`);
        manager.commitAssistantResponse(`reply ${i}`);
      }

      const state = manager.getConversationState();
      const coveredIds = state.turns.slice(0, 2).map((t) => t.id);

      manager.setRollingSummary({
        content: "Covered first 2 turns",
        updatedAt: "2026-01-01T00:10:00Z",
        coveredTurnIds: coveredIds,
        estimatedTokens: 10,
      });

      const eligibility = manager.getSummaryEligibility();
      expect(eligibility.newEligibleCount).toBe(
        eligibility.eligibleTurns.length - 2,
      );
    });

    it("should not count in-progress turns as eligible", () => {
      for (let i = 0; i < 8; i++) {
        manager.beginUserTurn(`msg ${i}`);
        manager.commitAssistantResponse(`reply ${i}`);
      }
      // Start a new turn but don't complete it
      manager.beginUserTurn("in progress");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);

      const eligibility = manager.getSummaryEligibility();
      // Only completed turns are eligible
      for (const turn of eligibility.eligibleTurns) {
        const state = manager.getConversationState();
        const matched = state.turns.find((t) => t.id === turn.id);
        expect(matched?.completedAt).toBeDefined();
      }
    });
  });

  describe("summary-covered turn IDs", () => {
    it("should return empty set with no summary", () => {
      expect(manager.getSummaryCoveredTurnIds().size).toBe(0);
    });

    it("should return covered IDs from stored summary", () => {
      manager.setRollingSummary({
        content: "Summary",
        updatedAt: "2026-01-01T00:10:00Z",
        coveredTurnIds: ["t1", "t2", "t3"],
        estimatedTokens: 5,
      });

      const covered = manager.getSummaryCoveredTurnIds();
      expect(covered.has("t1")).toBe(true);
      expect(covered.has("t2")).toBe(true);
      expect(covered.has("t3")).toBe(true);
      expect(covered.has("t4")).toBe(false);
    });
  });

  describe("buildPromptPlan with stored rolling summary", () => {
    it("should source rolling summary from stored state by default", () => {
      for (let i = 0; i < 10; i++) {
        manager.beginUserTurn(`msg ${i}`);
        manager.commitAssistantResponse(`reply ${i}`);
      }

      const state = manager.getConversationState();
      const coveredIds = state.turns.slice(0, 4).map((t) => t.id);

      manager.setRollingSummary({
        content: "Summary of turns 0-3",
        updatedAt: "2026-01-01T00:10:00Z",
        coveredTurnIds: coveredIds,
        estimatedTokens: 10,
      });

      const plan = manager.buildPromptPlan("system");

      expect(plan.usedRollingSummary).toBe(true);
      expect(plan.messages[0].content).toContain("<session_summary>");
      expect(plan.messages[0].content).toContain("Summary of turns 0-3");
    });

    it("should exclude summary-covered turns from raw history", () => {
      for (let i = 0; i < 10; i++) {
        manager.beginUserTurn(`msg ${i}`);
        manager.commitAssistantResponse(`reply ${i}`);
      }

      const state = manager.getConversationState();
      const coveredIds = state.turns.slice(0, 4).map((t) => t.id);

      manager.setRollingSummary({
        content: "Summary of turns 0-3",
        updatedAt: "2026-01-01T00:10:00Z",
        coveredTurnIds: coveredIds,
        estimatedTokens: 10,
      });

      const plan = manager.buildPromptPlan("system");

      for (const coveredId of coveredIds) {
        expect(plan.includedTurnIds).not.toContain(coveredId);
        expect(plan.omittedTurnIds).toContain(coveredId);
      }
    });

    it("should preserve recent unsummarized turns in raw history", () => {
      for (let i = 0; i < 10; i++) {
        manager.beginUserTurn(`msg ${i}`);
        manager.commitAssistantResponse(`reply ${i}`);
      }

      const state = manager.getConversationState();
      const coveredIds = state.turns.slice(0, 4).map((t) => t.id);
      const recentIds = state.turns.slice(4).map((t) => t.id);

      manager.setRollingSummary({
        content: "Summary",
        updatedAt: "2026-01-01T00:10:00Z",
        coveredTurnIds: coveredIds,
        estimatedTokens: 10,
      });

      const plan = manager.buildPromptPlan("system");

      for (const recentId of recentIds) {
        expect(plan.includedTurnIds).toContain(recentId);
      }
    });

    it("should still rehydrate unresolved tool chains with a summary present", () => {
      // Create enough completed turns to warrant a summary
      for (let i = 0; i < 8; i++) {
        manager.beginUserTurn(`msg ${i}`);
        manager.commitAssistantResponse(`reply ${i}`);
      }

      const state = manager.getConversationState();
      const coveredIds = state.turns.slice(0, 2).map((t) => t.id);

      manager.setRollingSummary({
        content: "Summary",
        updatedAt: "2026-01-01T00:10:00Z",
        coveredTurnIds: coveredIds,
        estimatedTokens: 10,
      });

      // Start a new turn with tools
      manager.beginUserTurn("Current task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);
      manager.recordToolResults([
        toolResult("tc-1", "tool", "tool output data"),
      ]);

      const plan = manager.buildPromptPlan("system");

      const toolMsg = plan.messages.find(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.toolResults![0].content).toBe("tool output data");
    });
  });

  describe("pinned memory", () => {
    const userSource: PinFactInput["source"] = { origin: "user" };

    it("pinFact adds an active record retrievable via getPinnedMemory", () => {
      const id = manager.pinFact({
        kind: "fact",
        content: "API base URL is https://example.com",
        source: userSource,
      });
      const records = manager.getPinnedMemory();
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(id);
      expect(records[0].lifecycle).toBe("active");
      expect(records[0].content).toBe("API base URL is https://example.com");
    });

    it("pinFact defaults scope to session", () => {
      manager.pinFact({
        kind: "decision",
        content: "Use ESM",
        source: userSource,
      });
      expect(manager.getPinnedMemory()[0].scope).toBe("session");
    });

    it("addProjectConstraint creates a project-scoped constraint", () => {
      manager.addProjectConstraint("No console.log in prod", userSource);
      const r = manager.getPinnedMemory()[0];
      expect(r.kind).toBe("constraint");
      expect(r.scope).toBe("project");
      expect(r.content).toBe("No console.log in prod");
    });

    it("duplicate active records are rejected", () => {
      manager.pinFact({
        kind: "fact",
        content: "Unique fact",
        source: userSource,
      });
      expect(() =>
        manager.pinFact({
          kind: "fact",
          content: "Unique fact",
          source: userSource,
        }),
      ).toThrow(MemoryValidationError);
    });

    it("empty content is rejected (MemoryValidationError)", () => {
      expect(() =>
        manager.pinFact({
          kind: "fact",
          content: "   ",
          source: userSource,
        }),
      ).toThrow(MemoryValidationError);
    });

    it("oversized content is rejected (default limit 2000 chars)", () => {
      expect(() =>
        manager.pinFact({
          kind: "fact",
          content: "x".repeat(2001),
          source: userSource,
        }),
      ).toThrow(MemoryValidationError);
    });

    it("oversized content is rejected with custom limit", () => {
      const limitedManager = new ContextManager({
        pinnedMemoryMaxContentLength: 500,
      });
      expect(() =>
        limitedManager.pinFact({
          kind: "fact",
          content: "x".repeat(501),
          source: userSource,
        }),
      ).toThrow(MemoryValidationError);
    });

    it("code fences rejected", () => {
      expect(() =>
        manager.pinFact({
          kind: "fact",
          content: "see ```js code```",
          source: userSource,
        }),
      ).toThrow(MemoryValidationError);
    });
  });

  describe("updateMemory", () => {
    const userSource: PinFactInput["source"] = { origin: "user" };

    it("updateMemory supersedes old record, creates new one", () => {
      const oldId = manager.pinFact({
        kind: "fact",
        content: "v1",
        source: userSource,
      });
      const newId = manager.updateMemory(oldId, { content: "v2" });
      expect(newId).not.toBe(oldId);
      const all = manager.getPinnedMemory({ includeInactive: true });
      const oldRec = all.find((r) => r.id === oldId)!;
      expect(oldRec.lifecycle).toBe("superseded");
      expect(oldRec.supersededById).toBe(newId);
    });

    it("only the replacement is returned by getPinnedMemory (default)", () => {
      const oldId = manager.pinFact({
        kind: "fact",
        content: "a",
        source: userSource,
      });
      manager.updateMemory(oldId, { content: "b" });
      const active = manager.getPinnedMemory();
      expect(active).toHaveLength(1);
      expect(active[0].content).toBe("b");
      expect(active[0].lifecycle).toBe("active");
    });

    it("getPinnedMemory with includeInactive shows superseded", () => {
      const oldId = manager.pinFact({
        kind: "constraint",
        content: "c1",
        source: userSource,
      });
      manager.updateMemory(oldId, { content: "c2" });
      const all = manager.getPinnedMemory({ includeInactive: true });
      expect(
        all.some((r) => r.id === oldId && r.lifecycle === "superseded"),
      ).toBe(true);
      expect(
        all.some((r) => r.content === "c2" && r.lifecycle === "active"),
      ).toBe(true);
    });

    it("updateMemory on non-existent id throws", () => {
      expect(() =>
        manager.updateMemory("00000000-0000-4000-8000-000000000000", {
          content: "x",
        }),
      ).toThrow(MemoryValidationError);
    });

    it("updateMemory on non-active record throws", () => {
      const id = manager.pinFact({
        kind: "fact",
        content: "orig",
        source: userSource,
      });
      const nextId = manager.updateMemory(id, { content: "next" });
      expect(() => manager.updateMemory(id, { content: "again" })).toThrow(
        MemoryValidationError,
      );
      expect(() =>
        manager.updateMemory(nextId, { content: "ok" }),
      ).not.toThrow();
    });
  });

  describe("unpinFact", () => {
    const userSource: PinFactInput["source"] = { origin: "user" };

    it("unpinFact marks record as removed", () => {
      const id = manager.pinFact({
        kind: "fact",
        content: "to remove",
        source: userSource,
      });
      manager.unpinFact(id, "no longer needed");
      const r = manager
        .getPinnedMemory({ includeInactive: true })
        .find((x) => x.id === id)!;
      expect(r.lifecycle).toBe("removed");
    });

    it("removed records excluded from getPinnedMemory default", () => {
      const id = manager.pinFact({
        kind: "fact",
        content: "gone",
        source: userSource,
      });
      manager.unpinFact(id);
      expect(manager.getPinnedMemory()).toEqual([]);
    });

    it("removed records visible with includeInactive", () => {
      const id = manager.pinFact({
        kind: "decision",
        content: "pick A",
        source: userSource,
      });
      manager.unpinFact(id);
      const all = manager.getPinnedMemory({ includeInactive: true });
      expect(all.some((r) => r.id === id && r.lifecycle === "removed")).toBe(
        true,
      );
    });

    it("unpinFact on already-removed throws", () => {
      const id = manager.pinFact({
        kind: "fact",
        content: "x",
        source: userSource,
      });
      manager.unpinFact(id);
      expect(() => manager.unpinFact(id)).toThrow(MemoryValidationError);
    });

    it("unpinFact on non-existent id throws", () => {
      expect(() =>
        manager.unpinFact("00000000-0000-4000-8000-000000000000"),
      ).toThrow(MemoryValidationError);
    });
  });

  describe("pinned memory in buildPromptPlan", () => {
    const userSource: PinFactInput["source"] = { origin: "user" };

    it("active pinned memory appears in system message as <pinned_memory> block", () => {
      manager.pinFact({
        kind: "fact",
        content: "Remember the token budget",
        source: userSource,
      });
      manager.beginUserTurn("Hi");
      const plan = manager.buildPromptPlan("You are helpful.");
      expect(plan.messages[0].role).toBe("system");
      expect(plan.messages[0].content).toContain("<pinned_memory>");
      expect(plan.messages[0].content).toContain("Remember the token budget");
    });

    it("superseded/removed memory not in system message", () => {
      const id = manager.pinFact({
        kind: "fact",
        content: "old fact",
        source: userSource,
      });
      manager.updateMemory(id, { content: "new fact" });
      manager.pinFact({
        kind: "decision",
        content: "will unpin",
        source: userSource,
      });
      const decisionId = manager
        .getPinnedMemory()
        .find((r) => r.content === "will unpin")!.id;
      manager.unpinFact(decisionId);

      const plan = manager.buildPromptPlan("sys");
      const sys = plan.messages[0].content;
      expect(sys).toContain("new fact");
      expect(sys).not.toContain("old fact");
      expect(sys).not.toContain("will unpin");
    });

    it("pinned memory present at retry level 3", () => {
      manager.pinFact({
        kind: "constraint",
        content: "Always cite sources",
        source: userSource,
      });
      manager.beginUserTurn("Q");
      manager.commitAssistantResponse("Thinking", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      const plan = manager.buildPromptPlan("system", undefined, {
        retryLevel: 3,
      });
      expect(plan.retryLevel).toBe(3);
      expect(plan.messages[0].content).toContain("<pinned_memory>");
      expect(plan.messages[0].content).toContain("Always cite sources");
    });

    it("empty pinned memory produces no <pinned_memory> block", () => {
      manager.beginUserTurn("Hi");
      const plan = manager.buildPromptPlan("Only system");
      expect(plan.messages[0].content).not.toContain("<pinned_memory>");
    });
  });

  describe("pinned memory lifecycle with clear/import", () => {
    const userSource: PinFactInput["source"] = { origin: "user" };

    it("clear() removes all pinned memory", () => {
      manager.pinFact({
        kind: "fact",
        content: "keeps",
        source: userSource,
      });
      manager.clear();
      expect(manager.getPinnedMemory()).toEqual([]);
    });

    it("importState restores pinned memory", () => {
      manager.pinFact({
        kind: "fact",
        content: "restored",
        source: userSource,
      });
      const snapshot = manager.getConversationState();
      manager.clear();
      manager.importState(snapshot);
      expect(manager.getPinnedMemory()).toHaveLength(1);
      expect(manager.getPinnedMemory()[0].content).toBe("restored");
    });

    it("getConversationState includes pinnedMemory array", () => {
      manager.pinFact({
        kind: "decision",
        content: "use vitest",
        source: userSource,
      });
      const state = manager.getConversationState();
      expect(state.pinnedMemory).toHaveLength(1);
      expect(state.pinnedMemory[0].kind).toBe("decision");
    });

    it("getConversationState deep-clones source so mutations do not leak back", () => {
      manager.pinFact({
        kind: "fact",
        content: "deep clone test",
        source: { origin: "tool", turnId: "t-1", toolCallId: "tc-1" },
      });

      const state = manager.getConversationState();
      (state.pinnedMemory[0].source as any).origin = "MUTATED";
      (state.pinnedMemory[0].source as any).turnId = "MUTATED";

      const fresh = manager.getConversationState();
      expect(fresh.pinnedMemory[0].source.origin).toBe("tool");
      expect(fresh.pinnedMemory[0].source.turnId).toBe("t-1");
    });

    it("getPinnedMemory deep-clones source so mutations do not leak back", () => {
      manager.pinFact({
        kind: "fact",
        content: "another clone test",
        source: { origin: "user", turnId: "t-2" },
      });

      const records = manager.getPinnedMemory();
      (records[0].source as any).origin = "MUTATED";

      const fresh = manager.getPinnedMemory();
      expect(fresh[0].source.origin).toBe("user");
    });

    it("importState deep-clones source so caller mutations do not affect internal state", () => {
      manager.pinFact({
        kind: "fact",
        content: "import clone test",
        source: { origin: "application" },
      });
      const state = manager.getConversationState();

      const target = new ContextManager();
      target.importState(state);

      (state.pinnedMemory[0].source as any).origin = "MUTATED";

      const internal = target.getPinnedMemory();
      expect(internal[0].source.origin).toBe("application");
    });
  });

  describe("pinned memory write-time validation of scope and source", () => {
    it("rejects invalid scope at write time", () => {
      expect(() =>
        manager.pinFact({
          kind: "fact",
          content: "test",
          scope: "global" as any,
          source: { origin: "user" },
        }),
      ).toThrow(MemoryValidationError);
    });

    it("rejects invalid source.origin at write time", () => {
      expect(() =>
        manager.pinFact({
          kind: "fact",
          content: "test",
          source: { origin: "system" as any },
        }),
      ).toThrow(MemoryValidationError);
    });

    it("rejects missing source at write time", () => {
      expect(() =>
        manager.pinFact({
          kind: "fact",
          content: "test",
          source: null as any,
        }),
      ).toThrow(MemoryValidationError);
    });

    it("rejects non-string source.turnId at write time", () => {
      expect(() =>
        manager.pinFact({
          kind: "fact",
          content: "test",
          source: { origin: "user", turnId: 123 as any },
        }),
      ).toThrow(MemoryValidationError);
    });
  });
});
