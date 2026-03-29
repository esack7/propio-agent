import {
  SummaryManager,
  computeSummaryEligibility,
  serializeTurnForSummary,
  SUMMARY_SYSTEM_PROMPT,
} from "../summaryManager.js";
import {
  RollingSummaryRecord,
  SummaryPolicy,
  DEFAULT_SUMMARY_POLICY,
  TurnRecord,
  TurnEntry,
} from "../types.js";
import { LLMProvider } from "../../providers/interface.js";
import { ChatRequest, ChatStreamEvent } from "../../providers/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(opts: {
  id: string;
  userMessage: string;
  entries?: TurnEntry[];
  completedAt?: string;
}): TurnRecord {
  return {
    id: opts.id,
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: opts.completedAt ?? "2026-01-01T00:01:00Z",
    importance: "normal",
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

function makeToolEntry(toolName: string, resultSummary: string): TurnEntry {
  return {
    kind: "tool",
    createdAt: "2026-01-01T00:00:02Z",
    message: {
      role: "tool",
      content: "",
      toolResults: [{ toolCallId: "tc-1", toolName, content: resultSummary }],
    },
    toolInvocations: [
      {
        toolCallId: "tc-1",
        toolName,
        status: "success" as const,
        resultSummary,
        artifactId: "art-1",
        mediaType: "text/plain",
        contentSizeChars: resultSummary.length,
      },
    ],
  };
}

function makeSummary(
  content: string,
  coveredTurnIds: string[],
): RollingSummaryRecord {
  return {
    content,
    updatedAt: "2026-01-01T00:00:00Z",
    coveredTurnIds,
    estimatedTokens: Math.ceil(content.length / 4),
  };
}

function makeMockProvider(responseText: string): LLMProvider {
  return {
    name: "mock",
    getCapabilities: () => ({ contextWindowTokens: 128000 }),
    async *streamChat(_request: ChatRequest): AsyncIterable<ChatStreamEvent> {
      yield { type: "assistant_text", delta: responseText };
    },
  };
}

// ---------------------------------------------------------------------------
// computeSummaryEligibility
// ---------------------------------------------------------------------------

describe("computeSummaryEligibility", () => {
  const policy = DEFAULT_SUMMARY_POLICY;

  it("should return no eligible turns when fewer than rawRecentTurns exist", () => {
    const turns = Array.from({ length: 4 }, (_, i) =>
      makeTurn({ id: `t${i}`, userMessage: `msg ${i}` }),
    );

    const result = computeSummaryEligibility(turns, undefined, policy);

    expect(result.eligibleTurns).toEqual([]);
    expect(result.shouldRefresh).toBe(false);
  });

  it("should identify eligible turns beyond the recent window", () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      makeTurn({ id: `t${i}`, userMessage: `msg ${i}` }),
    );

    const result = computeSummaryEligibility(turns, undefined, policy);

    expect(result.eligibleTurns).toHaveLength(4);
    expect(result.eligibleTurns.map((t) => t.id)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("should trigger refresh when new eligible count meets interval", () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      makeTurn({ id: `t${i}`, userMessage: `msg ${i}` }),
    );

    const result = computeSummaryEligibility(turns, undefined, {
      ...policy,
      refreshIntervalTurns: 3,
    });

    expect(result.shouldRefresh).toBe(true);
    expect(result.reason).toBe("turn_cadence");
    expect(result.newEligibleCount).toBe(4);
  });

  it("should not trigger refresh when new eligible count is below interval", () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      makeTurn({ id: `t${i}`, userMessage: `msg ${i}` }),
    );

    const existing = makeSummary("old summary", ["t0", "t1", "t2"]);

    const result = computeSummaryEligibility(turns, existing, {
      ...policy,
      refreshIntervalTurns: 3,
    });

    expect(result.newEligibleCount).toBe(1);
    expect(result.shouldRefresh).toBe(false);
  });

  it("should trigger refresh on context pressure even with fewer new turns", () => {
    const turns = Array.from({ length: 8 }, (_, i) =>
      makeTurn({ id: `t${i}`, userMessage: `msg ${i}` }),
    );
    const existing = makeSummary("old summary", ["t0"]);

    const result = computeSummaryEligibility(
      turns,
      existing,
      { ...policy, contextPressureThreshold: 0.6, refreshIntervalTurns: 10 },
      7000,
      10000,
    );

    expect(result.shouldRefresh).toBe(true);
    expect(result.reason).toBe("context_pressure");
  });

  it("should not trigger context pressure refresh when no new eligible turns", () => {
    const turns = Array.from({ length: 8 }, (_, i) =>
      makeTurn({ id: `t${i}`, userMessage: `msg ${i}` }),
    );
    // All eligible turns are already covered
    const existing = makeSummary("old summary", ["t0", "t1"]);

    const result = computeSummaryEligibility(
      turns,
      existing,
      { ...policy, contextPressureThreshold: 0.6, refreshIntervalTurns: 10 },
      7000,
      10000,
    );

    // Context pressure IS high, and there IS a new eligible turn (t1 is
    // covered but eligible count = 2; 8 turns - 6 raw = 2 eligible; 2 covered
    // gives 0 new). Wait — rawRecentTurns=6, so eligible=[t0,t1], both covered,
    // so newEligibleCount=0. With no new eligible turns, context pressure
    // alone should not trigger a refresh (nothing new to summarize).
    expect(result.shouldRefresh).toBe(false);
  });

  it("should correctly track coverage with existing summary", () => {
    const turns = Array.from({ length: 12 }, (_, i) =>
      makeTurn({ id: `t${i}`, userMessage: `msg ${i}` }),
    );
    const existing = makeSummary("old summary", ["t0", "t1", "t2"]);

    const result = computeSummaryEligibility(turns, existing, policy);

    expect(result.eligibleTurns).toHaveLength(6);
    expect(result.newEligibleCount).toBe(3);
    expect(result.shouldRefresh).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// serializeTurnForSummary
// ---------------------------------------------------------------------------

describe("serializeTurnForSummary", () => {
  it("should serialize a simple user/assistant turn", () => {
    const turn = makeTurn({
      id: "t1",
      userMessage: "What is 2+2?",
      entries: [makeAssistantEntry("4")],
    });

    const text = serializeTurnForSummary(turn);
    expect(text).toContain("User: What is 2+2?");
    expect(text).toContain("Assistant: 4");
  });

  it("should use tool resultSummary, not raw artifact content", () => {
    const turn = makeTurn({
      id: "t1",
      userMessage: "Read the file",
      entries: [
        makeAssistantEntry(""),
        makeToolEntry("read_file", "Contents of foo.txt: hello world"),
        makeAssistantEntry("The file contains hello world"),
      ],
    });

    const text = serializeTurnForSummary(turn);
    expect(text).toContain("[read_file success]: Contents of foo.txt");
    expect(text).not.toContain("artifactId");
  });

  it("should include tool call names when assistant calls tools", () => {
    const turn = makeTurn({
      id: "t1",
      userMessage: "Search for files",
      entries: [
        {
          kind: "assistant" as const,
          createdAt: "2026-01-01T00:00:01Z",
          message: {
            role: "assistant" as const,
            content: "",
            toolCalls: [
              { id: "tc-1", function: { name: "search", arguments: {} } },
            ],
          },
        },
        makeToolEntry("search", "Found 3 matches"),
        makeAssistantEntry("Found 3 results"),
      ],
    });

    const text = serializeTurnForSummary(turn);
    expect(text).toContain("[Called tools: search]");
  });

  it("should truncate long tool summaries to 500 chars", () => {
    const longSummary = "x".repeat(1000);
    const turn = makeTurn({
      id: "t1",
      userMessage: "Get data",
      entries: [makeAssistantEntry(""), makeToolEntry("fetch", longSummary)],
    });

    const text = serializeTurnForSummary(turn);
    const toolLine = text.split("\n").find((l) => l.includes("[fetch"));
    expect(toolLine!.length).toBeLessThan(600);
  });
});

// ---------------------------------------------------------------------------
// SummaryManager.generateSummary
// ---------------------------------------------------------------------------

describe("SummaryManager", () => {
  const manager = new SummaryManager();

  it("should generate a summary from eligible turns", async () => {
    const turns = Array.from({ length: 3 }, (_, i) =>
      makeTurn({
        id: `t${i}`,
        userMessage: `Question ${i}`,
        entries: [makeAssistantEntry(`Answer ${i}`)],
      }),
    );

    const provider = makeMockProvider(
      "The user asked 3 questions and received answers.",
    );

    const result = await manager.generateSummary(
      provider,
      "test-model",
      turns,
      undefined,
      DEFAULT_SUMMARY_POLICY,
    );

    expect(result.summary.content).toBe(
      "The user asked 3 questions and received answers.",
    );
    expect(result.summary.coveredTurnIds).toEqual(["t0", "t1", "t2"]);
    expect(result.summary.estimatedTokens).toBeGreaterThan(0);
    expect(result.summary.updatedAt).toBeDefined();
    expect(result.refreshedTurnCount).toBe(3);
  });

  it("should pass previous summary to the provider for incremental build", async () => {
    const turns = [
      makeTurn({
        id: "t3",
        userMessage: "New question",
        entries: [makeAssistantEntry("New answer")],
      }),
    ];

    let capturedMessages: any[] = [];
    const provider: LLMProvider = {
      name: "mock",
      getCapabilities: () => ({ contextWindowTokens: 128000 }),
      async *streamChat(request: ChatRequest) {
        capturedMessages = request.messages;
        yield { type: "assistant_text" as const, delta: "Updated summary" };
      },
    };

    const previousSummary = makeSummary("Previous session context", [
      "t0",
      "t1",
      "t2",
    ]);

    await manager.generateSummary(
      provider,
      "test-model",
      turns,
      previousSummary,
      DEFAULT_SUMMARY_POLICY,
    );

    const userMsg = capturedMessages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("<previous_summary>");
    expect(userMsg.content).toContain("Previous session context");
    expect(userMsg.content).toContain("<new_turns>");
  });

  it("should use the correct system prompt for summarization", async () => {
    let capturedMessages: any[] = [];
    const provider: LLMProvider = {
      name: "mock",
      getCapabilities: () => ({ contextWindowTokens: 128000 }),
      async *streamChat(request: ChatRequest) {
        capturedMessages = request.messages;
        yield { type: "assistant_text" as const, delta: "Summary" };
      },
    };

    await manager.generateSummary(
      provider,
      "test-model",
      [makeTurn({ id: "t0", userMessage: "hi" })],
      undefined,
      DEFAULT_SUMMARY_POLICY,
    );

    const systemMsg = capturedMessages.find((m: any) => m.role === "system");
    expect(systemMsg.content).toBe(SUMMARY_SYSTEM_PROMPT);
  });

  it("should include target tokens in the user prompt", async () => {
    let capturedMessages: any[] = [];
    const provider: LLMProvider = {
      name: "mock",
      getCapabilities: () => ({ contextWindowTokens: 128000 }),
      async *streamChat(request: ChatRequest) {
        capturedMessages = request.messages;
        yield { type: "assistant_text" as const, delta: "Summary" };
      },
    };

    await manager.generateSummary(
      provider,
      "test-model",
      [makeTurn({ id: "t0", userMessage: "hi" })],
      undefined,
      { ...DEFAULT_SUMMARY_POLICY, summaryTargetTokens: 256 },
    );

    const userMsg = capturedMessages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("256 tokens");
  });

  it("should handle provider errors gracefully (throws for caller to catch)", async () => {
    const provider: LLMProvider = {
      name: "mock",
      getCapabilities: () => ({ contextWindowTokens: 128000 }),
      async *streamChat(_request: ChatRequest) {
        throw new Error("Provider unavailable");
      },
    };

    await expect(
      manager.generateSummary(
        provider,
        "test-model",
        [makeTurn({ id: "t0", userMessage: "hi" })],
        undefined,
        DEFAULT_SUMMARY_POLICY,
      ),
    ).rejects.toThrow("Provider unavailable");
  });

  it("should not include raw artifact content, only resultSummary", async () => {
    let capturedMessages: any[] = [];
    const provider: LLMProvider = {
      name: "mock",
      getCapabilities: () => ({ contextWindowTokens: 128000 }),
      async *streamChat(request: ChatRequest) {
        capturedMessages = request.messages;
        yield { type: "assistant_text" as const, delta: "Summary" };
      },
    };

    const turn = makeTurn({
      id: "t0",
      userMessage: "Read file",
      entries: [
        makeAssistantEntry(""),
        makeToolEntry("read_file", "short summary of file contents"),
        makeAssistantEntry("Done"),
      ],
    });

    await manager.generateSummary(
      provider,
      "test-model",
      [turn],
      undefined,
      DEFAULT_SUMMARY_POLICY,
    );

    const userMsg = capturedMessages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("short summary of file contents");
    expect(userMsg.content).not.toContain("art-1");
  });

  it("should only serialize newly eligible turns, not already-covered ones", async () => {
    const allTurns = Array.from({ length: 5 }, (_, i) =>
      makeTurn({
        id: `t${i}`,
        userMessage: `Question ${i}`,
        entries: [makeAssistantEntry(`Answer ${i}`)],
      }),
    );

    let capturedMessages: any[] = [];
    const provider: LLMProvider = {
      name: "mock",
      getCapabilities: () => ({ contextWindowTokens: 128000 }),
      async *streamChat(request: ChatRequest) {
        capturedMessages = request.messages;
        yield { type: "assistant_text" as const, delta: "Updated summary" };
      },
    };

    const previousSummary = makeSummary("Summary of t0-t2", ["t0", "t1", "t2"]);

    const result = await manager.generateSummary(
      provider,
      "test-model",
      allTurns,
      previousSummary,
      DEFAULT_SUMMARY_POLICY,
    );

    const userMsg = capturedMessages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("Question 3");
    expect(userMsg.content).toContain("Question 4");
    expect(userMsg.content).not.toContain("Question 0");
    expect(userMsg.content).not.toContain("Question 1");
    expect(userMsg.content).not.toContain("Question 2");

    expect(result.summary.coveredTurnIds).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
    expect(result.refreshedTurnCount).toBe(2);
  });

  it("should short-circuit when all eligible turns are already covered", async () => {
    let providerCalled = false;
    const provider: LLMProvider = {
      name: "mock",
      getCapabilities: () => ({ contextWindowTokens: 128000 }),
      async *streamChat(_request: ChatRequest) {
        providerCalled = true;
        yield { type: "assistant_text" as const, delta: "Should not run" };
      },
    };

    const turns = [
      makeTurn({ id: "t0", userMessage: "Q0" }),
      makeTurn({ id: "t1", userMessage: "Q1" }),
    ];
    const previousSummary = makeSummary("Covers both", ["t0", "t1"]);

    const result = await manager.generateSummary(
      provider,
      "test-model",
      turns,
      previousSummary,
      DEFAULT_SUMMARY_POLICY,
    );

    expect(providerCalled).toBe(false);
    expect(result.refreshedTurnCount).toBe(0);
    expect(result.summary.content).toBe("Covers both");
    expect(result.summary.coveredTurnIds).toEqual(["t0", "t1"]);
  });
});
