import { PromptBuilder, PromptBuildRequest } from "../promptBuilder.js";
import {
  PromptPlan,
  PromptBudgetPolicy,
  DEFAULT_BUDGET_POLICY,
  ConversationState,
  TurnRecord,
  TurnEntry,
  ArtifactRecord,
} from "../types.js";
import { ChatMessage } from "../../providers/types.js";
import { estimateTokens } from "../../diagnostics.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTurn(opts: {
  id: string;
  userMessage: string;
  entries?: TurnEntry[];
  completedAt?: string;
  importance?: "low" | "normal" | "high";
}): TurnRecord {
  return {
    id: opts.id,
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: opts.completedAt,
    importance: opts.importance ?? "normal",
    userMessage: { role: "user", content: opts.userMessage },
    entries: opts.entries ?? [],
  };
}

function makeAssistantEntry(content: string): TurnEntry {
  return {
    kind: "assistant",
    createdAt: "2026-01-01T00:00:01Z",
    message: { role: "assistant", content },
  };
}

function makeToolEntry(
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    content: string;
    artifactId: string;
  }>,
): TurnEntry {
  return {
    kind: "tool",
    createdAt: "2026-01-01T00:00:02Z",
    message: {
      role: "tool",
      content: "",
      toolResults: toolResults.map((tr) => ({
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        content: tr.content,
      })),
    },
    toolInvocations: toolResults.map((tr) => ({
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      status: "success" as const,
      resultSummary: tr.content,
      artifactId: tr.artifactId,
      mediaType: "text/plain",
      contentSizeChars: tr.content.length,
    })),
  };
}

function makeArtifact(
  id: string,
  content: string,
  turnIds: string[] = [],
): ArtifactRecord {
  return {
    id,
    type: "tool_result",
    mediaType: "text/plain",
    createdAt: "2026-01-01T00:00:00Z",
    content,
    contentSizeChars: content.length,
    estimatedTokens: estimateTokens(content.length),
    referencingTurnIds: turnIds,
  };
}

function makeState(opts?: {
  preamble?: ChatMessage[];
  turns?: TurnRecord[];
  artifacts?: ArtifactRecord[];
}): ConversationState {
  return {
    preamble: opts?.preamble ?? [],
    turns: opts?.turns ?? [],
    artifacts: opts?.artifacts ?? [],
  };
}

function makeRequest(opts: {
  systemPrompt?: string;
  state?: ConversationState;
  contextWindowTokens?: number;
  policy?: PromptBudgetPolicy;
  extraUserInstruction?: string;
  rollingSummary?: string;
  retryLevel?: number;
  artifacts?: Map<string, ArtifactRecord>;
}): PromptBuildRequest {
  const artifacts = opts.artifacts ?? new Map();
  const state = opts.state ?? makeState();
  return {
    systemPrompt: opts.systemPrompt ?? "You are a helpful assistant.",
    conversationState: state,
    contextWindowTokens: opts.contextWindowTokens ?? 128000,
    policy: opts.policy ?? DEFAULT_BUDGET_POLICY,
    extraUserInstruction: opts.extraUserInstruction,
    rollingSummary: opts.rollingSummary,
    retryLevel: opts.retryLevel,
    artifactLookup: (id: string) => artifacts.get(id),
    isCurrentTurnUnresolved: (turnId: string) => {
      const turn = state.turns.find((t) => t.id === turnId);
      return turn != null && !turn.completedAt;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PromptBuilder", () => {
  const builder = new PromptBuilder();

  describe("basic plan construction", () => {
    it("should produce system-first messages with a single user turn", () => {
      const turn = makeTurn({ id: "t1", userMessage: "Hello" });
      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns: [turn] }),
        }),
      );

      expect(plan.messages).toHaveLength(2);
      expect(plan.messages[0].role).toBe("system");
      expect(plan.messages[1].role).toBe("user");
      expect(plan.messages[1].content).toBe("Hello");
    });

    it("should include all completed turns in chronological order", () => {
      const t1 = makeTurn({
        id: "t1",
        userMessage: "First",
        completedAt: "2026-01-01T00:01:00Z",
        entries: [makeAssistantEntry("Reply 1")],
      });
      const t2 = makeTurn({
        id: "t2",
        userMessage: "Second",
        completedAt: "2026-01-01T00:02:00Z",
        entries: [makeAssistantEntry("Reply 2")],
      });

      const plan = builder.buildPlan(
        makeRequest({ state: makeState({ turns: [t1, t2] }) }),
      );

      expect(plan.messages.map((m) => m.role)).toEqual([
        "system",
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(plan.includedTurnIds).toEqual(["t1", "t2"]);
      expect(plan.omittedTurnIds).toEqual([]);
    });

    it("should append extra user instruction at the end", () => {
      const turn = makeTurn({ id: "t1", userMessage: "Question" });
      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns: [turn] }),
          extraUserInstruction: "No tools allowed.",
        }),
      );

      const last = plan.messages[plan.messages.length - 1];
      expect(last.role).toBe("user");
      expect(last.content).toBe("No tools allowed.");
    });

    it("should include preamble messages", () => {
      const preamble: ChatMessage[] = [
        { role: "assistant", content: "Orphan" },
      ];
      const plan = builder.buildPlan(
        makeRequest({ state: makeState({ preamble }) }),
      );

      expect(plan.messages).toHaveLength(2);
      expect(plan.messages[1].role).toBe("assistant");
      expect(plan.messages[1].content).toBe("Orphan");
    });
  });

  describe("PromptPlan diagnostics fields", () => {
    it("should populate all required diagnostic fields", () => {
      const t1 = makeTurn({
        id: "t1",
        userMessage: "Hi",
        completedAt: "2026-01-01T00:01:00Z",
        entries: [makeAssistantEntry("Hello")],
      });
      const plan = builder.buildPlan(
        makeRequest({ state: makeState({ turns: [t1] }) }),
      );

      expect(plan.estimatedPromptTokens).toBeGreaterThan(0);
      expect(plan.reservedOutputTokens).toBe(
        DEFAULT_BUDGET_POLICY.reservedOutputTokens,
      );
      expect(plan.includedTurnIds).toContain("t1");
      expect(plan.omittedTurnIds).toEqual([]);
      expect(plan.includedArtifactIds).toEqual([]);
      expect(plan.usedRollingSummary).toBe(false);
      expect(plan.retryLevel).toBe(0);
    });

    it("should report includedArtifactIds for tool entries", () => {
      const artifact = makeArtifact("art-1", "tool output data", ["t1"]);
      const toolEntry = makeToolEntry([
        {
          toolCallId: "tc-1",
          toolName: "read",
          content: "tool output data",
          artifactId: "art-1",
        },
      ]);
      const t1 = makeTurn({
        id: "t1",
        userMessage: "Read file",
        completedAt: "2026-01-01T00:01:00Z",
        entries: [
          makeAssistantEntry("Sure"),
          toolEntry,
          makeAssistantEntry("Done"),
        ],
      });

      const artifacts = new Map([["art-1", artifact]]);
      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns: [t1], artifacts: [artifact] }),
          artifacts,
        }),
      );

      expect(plan.includedArtifactIds).toContain("art-1");
    });
  });

  describe("budget-driven turn pruning", () => {
    it("should omit older turns when budget is tight", () => {
      const longMessage = "x".repeat(10000);
      const turns = Array.from({ length: 10 }, (_, i) =>
        makeTurn({
          id: `t${i}`,
          userMessage: longMessage,
          completedAt: `2026-01-01T00:0${i}:00Z`,
          entries: [makeAssistantEntry(longMessage)],
        }),
      );

      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns }),
          contextWindowTokens: 10000,
        }),
      );

      expect(plan.omittedTurnIds.length).toBeGreaterThan(0);
      expect(plan.includedTurnIds.length).toBeLessThan(10);
      expect(plan.includedTurnIds.length).toBeGreaterThan(0);
    });

    it("should always include the current (unfinished) turn", () => {
      const longMessage = "x".repeat(10000);
      const completedTurns = Array.from({ length: 5 }, (_, i) =>
        makeTurn({
          id: `t${i}`,
          userMessage: longMessage,
          completedAt: `2026-01-01T00:0${i}:00Z`,
          entries: [makeAssistantEntry(longMessage)],
        }),
      );
      const currentTurn = makeTurn({
        id: "current",
        userMessage: "What now?",
      });

      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns: [...completedTurns, currentTurn] }),
          contextWindowTokens: 10000,
        }),
      );

      expect(plan.includedTurnIds).toContain("current");
    });

    it("should respect maxRecentTurns policy", () => {
      const turns = Array.from({ length: 20 }, (_, i) =>
        makeTurn({
          id: `t${i}`,
          userMessage: `Message ${i}`,
          completedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
          entries: [makeAssistantEntry(`Reply ${i}`)],
        }),
      );

      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns }),
          policy: { ...DEFAULT_BUDGET_POLICY, maxRecentTurns: 5 },
        }),
      );

      expect(plan.includedTurnIds.length).toBeLessThanOrEqual(5);
      expect(plan.omittedTurnIds.length).toBeGreaterThanOrEqual(15);
    });
  });

  describe("unresolved tool-chain protection", () => {
    it("should rehydrate unresolved current-turn tool results from artifacts", () => {
      const rawContent = "full raw artifact content here";
      const artifact = makeArtifact("art-1", rawContent, ["t1"]);
      const toolEntry = makeToolEntry([
        {
          toolCallId: "tc-1",
          toolName: "read",
          content: "summary only",
          artifactId: "art-1",
        },
      ]);

      const currentTurn = makeTurn({
        id: "t1",
        userMessage: "Read it",
        entries: [makeAssistantEntry(""), toolEntry],
      });

      const artifacts = new Map([["art-1", artifact]]);
      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns: [currentTurn], artifacts: [artifact] }),
          artifacts,
        }),
      );

      const toolMsg = plan.messages.find(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.toolResults![0].content).toBe(rawContent);
    });

    it("should use summary for resolved tool results in the current turn", () => {
      const longRawContent = "x".repeat(5000);
      const summary = "short summary";
      const artifact = makeArtifact("art-1", longRawContent, ["t1"]);

      const toolEntry = makeToolEntry([
        {
          toolCallId: "tc-1",
          toolName: "read",
          content: summary,
          artifactId: "art-1",
        },
      ]);

      const currentTurn = makeTurn({
        id: "t1",
        userMessage: "Multi-step",
        entries: [
          makeAssistantEntry("Step 1"),
          toolEntry,
          makeAssistantEntry("Step 2 - tool is resolved now"),
        ],
      });

      const artifacts = new Map([["art-1", artifact]]);
      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns: [currentTurn], artifacts: [artifact] }),
          artifacts,
        }),
      );

      const toolMsg = plan.messages.find(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsg!.toolResults![0].content).toBe(summary);
    });

    it("should use summary for completed turn tool results", () => {
      const summary = "truncated summary";
      const toolEntry = makeToolEntry([
        {
          toolCallId: "tc-1",
          toolName: "read",
          content: summary,
          artifactId: "art-1",
        },
      ]);

      const completedTurn = makeTurn({
        id: "t1",
        userMessage: "Done task",
        completedAt: "2026-01-01T00:01:00Z",
        entries: [
          makeAssistantEntry(""),
          toolEntry,
          makeAssistantEntry("All done"),
        ],
      });

      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns: [completedTurn] }),
        }),
      );

      const toolMsg = plan.messages.find(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsg!.toolResults![0].content).toBe(summary);
    });
  });

  describe("retry levels", () => {
    const makeManyTurns = (count: number): TurnRecord[] =>
      Array.from({ length: count }, (_, i) =>
        makeTurn({
          id: `t${i}`,
          userMessage: `Message ${i}`,
          completedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
          entries: [makeAssistantEntry(`Reply ${i}`)],
        }),
      );

    it("should include more turns at level 0 than level 1", () => {
      const turns = makeManyTurns(20);
      const baseRequest = makeRequest({
        state: makeState({ turns }),
        policy: { ...DEFAULT_BUDGET_POLICY, maxRecentTurns: 20 },
      });

      const plan0 = builder.buildPlan({ ...baseRequest, retryLevel: 0 });
      const plan1 = builder.buildPlan({ ...baseRequest, retryLevel: 1 });

      expect(plan0.includedTurnIds.length).toBeGreaterThanOrEqual(
        plan1.includedTurnIds.length,
      );
      expect(plan0.retryLevel).toBe(0);
      expect(plan1.retryLevel).toBe(1);
    });

    it("should include more turns at level 1 than level 2", () => {
      const turns = makeManyTurns(20);
      const baseRequest = makeRequest({
        state: makeState({ turns }),
        policy: { ...DEFAULT_BUDGET_POLICY, maxRecentTurns: 20 },
      });

      const plan1 = builder.buildPlan({ ...baseRequest, retryLevel: 1 });
      const plan2 = builder.buildPlan({ ...baseRequest, retryLevel: 2 });

      expect(plan1.includedTurnIds.length).toBeGreaterThanOrEqual(
        plan2.includedTurnIds.length,
      );
      expect(plan2.retryLevel).toBe(2);
    });

    it("should produce minimal prompt at level 3", () => {
      const turns = makeManyTurns(10);
      const currentTurn = makeTurn({
        id: "current",
        userMessage: "Latest question",
      });

      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns: [...turns, currentTurn] }),
          retryLevel: 3,
        }),
      );

      expect(plan.retryLevel).toBe(3);
      expect(plan.includedTurnIds).toEqual(["current"]);
      expect(plan.omittedTurnIds.length).toBe(10);
      expect(plan.messages[0].role).toBe("system");
      expect(plan.messages[1].role).toBe("user");
      expect(plan.messages[1].content).toBe("Latest question");
    });

    it("should include system + current user + extra instruction at level 3", () => {
      const currentTurn = makeTurn({
        id: "current",
        userMessage: "Question",
      });

      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns: [currentTurn] }),
          retryLevel: 3,
          extraUserInstruction: "No tools.",
        }),
      );

      expect(plan.messages).toHaveLength(3);
      expect(plan.messages[0].role).toBe("system");
      expect(plan.messages[1].role).toBe("user");
      expect(plan.messages[2].content).toBe("No tools.");
    });

    it("should include unresolved tool chain in minimal prompt (level 3)", () => {
      const toolEntry = makeToolEntry([
        {
          toolCallId: "tc-1",
          toolName: "read",
          content: "summary",
          artifactId: "art-1",
        },
      ]);

      const currentTurn = makeTurn({
        id: "current",
        userMessage: "Do task",
        entries: [makeAssistantEntry("Calling tool"), toolEntry],
      });

      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns: [currentTurn] }),
          retryLevel: 3,
        }),
      );

      const roles = plan.messages.map((m) => m.role);
      expect(roles).toContain("assistant");
      expect(roles).toContain("tool");
    });

    it("should rehydrate unresolved tool output from artifacts at level 3", () => {
      const rawContent = "full raw tool output for the model to reason about";
      const artifact = makeArtifact("art-1", rawContent, ["current"]);
      const toolEntry = makeToolEntry([
        {
          toolCallId: "tc-1",
          toolName: "read",
          content: "short summary",
          artifactId: "art-1",
        },
      ]);

      const currentTurn = makeTurn({
        id: "current",
        userMessage: "Do task",
        entries: [makeAssistantEntry("Calling tool"), toolEntry],
      });

      const artifacts = new Map([["art-1", artifact]]);
      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({
            turns: [currentTurn],
            artifacts: [artifact],
          }),
          artifacts,
          retryLevel: 3,
        }),
      );

      const toolMsg = plan.messages.find(
        (m) => m.role === "tool" && m.toolResults?.length,
      );
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.toolResults![0].content).toBe(rawContent);
      expect(plan.includedArtifactIds).toContain("art-1");
    });
  });

  describe("rolling summary", () => {
    it("should not use rolling summary when no turns are omitted", () => {
      const t1 = makeTurn({
        id: "t1",
        userMessage: "Hi",
        completedAt: "2026-01-01T00:01:00Z",
        entries: [makeAssistantEntry("Hello")],
      });

      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns: [t1] }),
          rollingSummary: "Summary of older context",
        }),
      );

      expect(plan.usedRollingSummary).toBe(false);
      expect(
        plan.messages.find((m) => m.content === "Summary of older context"),
      ).toBeUndefined();
    });

    it("should include rolling summary when turns are omitted", () => {
      const longMessage = "x".repeat(10000);
      const turns = Array.from({ length: 10 }, (_, i) =>
        makeTurn({
          id: `t${i}`,
          userMessage: longMessage,
          completedAt: `2026-01-01T00:0${i}:00Z`,
          entries: [makeAssistantEntry(longMessage)],
        }),
      );

      const plan = builder.buildPlan(
        makeRequest({
          state: makeState({ turns }),
          contextWindowTokens: 10000,
          rollingSummary: "Summary of older context",
        }),
      );

      expect(plan.usedRollingSummary).toBe(true);
      expect(
        plan.messages.some((m) => m.content === "Summary of older context"),
      ).toBe(true);
    });

    it("should accept optional rolling summary without using it when not needed", () => {
      const plan = builder.buildPlan(
        makeRequest({
          rollingSummary: "Some summary",
        }),
      );

      expect(plan.usedRollingSummary).toBe(false);
    });
  });

  describe("provider request payload", () => {
    it("should produce plain ChatMessage[] without turn or artifact metadata", () => {
      const t1 = makeTurn({
        id: "t1",
        userMessage: "Hello",
        completedAt: "2026-01-01T00:01:00Z",
        entries: [makeAssistantEntry("Hi")],
      });

      const plan = builder.buildPlan(
        makeRequest({ state: makeState({ turns: [t1] }) }),
      );

      for (const msg of plan.messages) {
        expect(msg).toHaveProperty("role");
        expect(msg).toHaveProperty("content");
        expect(msg).not.toHaveProperty("turnId");
        expect(msg).not.toHaveProperty("artifactId");
      }
    });
  });

  describe("budget arithmetic", () => {
    it("should reserve output tokens from the context window", () => {
      const plan = builder.buildPlan(
        makeRequest({
          contextWindowTokens: 10000,
          policy: { ...DEFAULT_BUDGET_POLICY, reservedOutputTokens: 3000 },
        }),
      );

      expect(plan.reservedOutputTokens).toBe(3000);
      expect(plan.estimatedPromptTokens).toBeLessThan(10000 - 3000);
    });
  });
});
