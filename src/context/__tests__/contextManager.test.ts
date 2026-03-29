import { ContextManager } from "../contextManager.js";
import { RESERVED_OUTPUT_TOKENS, estimateTokens } from "../../diagnostics.js";
import { ConversationState, TurnRecord } from "../types.js";

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
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "tool", content: "result" },
      ]);

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
            name: "write_file",
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
          function: { name: "read_file", arguments: { path: "foo.txt" } },
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
        { id: "tc-1", function: { name: "read_file", arguments: {} } },
        { id: "tc-2", function: { name: "write_file", arguments: {} } },
      ]);

      const results = [
        { toolCallId: "tc-1", toolName: "read_file", content: "file content" },
        { toolCallId: "tc-2", toolName: "write_file", content: "ok" },
      ];
      manager.recordToolResults(results);

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
        { toolCallId: "call-a", toolName: "tool_a", content: "result-a" },
        { toolCallId: "call-b", toolName: "tool_b", content: "result-b" },
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
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "tool", content: "result" },
      ]);

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
      manager.recordToolResults([
        { toolCallId: "tc", toolName: "t", content: "r" },
      ]);
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
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "tool", content: "result" },
      ]);

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
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "tool", content: "result" },
      ]);

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
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "tool", content: "ok" },
      ]);
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
    it("should return empty preamble and turns for a new manager", () => {
      const state = manager.getConversationState();
      expect(state.preamble).toEqual([]);
      expect(state.turns).toEqual([]);
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
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "ls", content: "file.txt" },
      ]);
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

      // Iteration 1: assistant calls tool
      manager.commitAssistantResponse("Step 1", [
        { id: "tc-1", function: { name: "read", arguments: {} } },
      ]);
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "read", content: "data1" },
      ]);

      // Iteration 2: assistant calls another tool
      manager.commitAssistantResponse("Step 2", [
        { id: "tc-2", function: { name: "write", arguments: {} } },
      ]);
      manager.recordToolResults([
        { toolCallId: "tc-2", toolName: "write", content: "ok" },
      ]);

      // Final answer
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
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "tool", content: "result" },
      ]);
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
      // First iteration: tool call + result
      manager.commitAssistantResponse("Step 1", [
        { id: "tc-1", function: { name: "read", arguments: {} } },
      ]);
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "read", content: "data" },
      ]);
      // Second iteration: another tool call (unresolved)
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
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "t", content: "ok" },
      ]);

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
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "tool", content: "ok" },
      ]);

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
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "tool", content: "ok" },
      ]);

      expect(
        manager.getConversationState().turns[0].completedAt,
      ).toBeUndefined();

      manager.commitAssistantResponse("Final answer");

      expect(
        manager.getConversationState().turns[0].completedAt,
      ).toBeDefined();
    });

    it("should set completedAt when final answer comes via no-tools fallback pattern", () => {
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "tool", arguments: {} } },
      ]);
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "tool", content: "ok" },
      ]);

      // Simulate no-tools fallback: remove unresolved assistant, then commit final
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
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "t", content: "big result here" },
      ]);

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
      manager.recordToolResults([
        { toolCallId: "tc-1", toolName: "t", content: "ok" },
      ]);
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
});
