import { ContextManager } from "../contextManager.js";
import { RESERVED_OUTPUT_TOKENS } from "../../diagnostics.js";

describe("ContextManager", () => {
  let manager: ContextManager;

  beforeEach(() => {
    manager = new ContextManager();
  });

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
});
