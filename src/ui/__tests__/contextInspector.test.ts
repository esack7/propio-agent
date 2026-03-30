import type {
  ArtifactRecord,
  ConversationState,
  PinnedMemoryRecord,
  PromptPlan,
  RollingSummaryRecord,
  ToolInvocationRecord,
  TurnEntry,
  TurnRecord,
} from "../../context/types.js";
import type { PromptPlanSnapshot } from "../../agent.js";
import type { ChatMessage } from "../../providers/types.js";
import {
  formatContextOverview,
  formatContextStats,
  formatMemoryView,
  formatPromptPlan,
  formatPromptPlanCompact,
} from "../contextInspector.js";

function emptyConversationState(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    preamble: [],
    turns: [],
    artifacts: [],
    pinnedMemory: [],
    ...overrides,
  };
}

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: "art-1",
    type: "tool_result",
    mediaType: "text/plain",
    createdAt: "2026-01-01T00:00:00.000Z",
    content: "payload",
    contentSizeChars: 7,
    referencingTurnIds: ["turn-a"],
    ...overrides,
  };
}

function toolInvocation(
  overrides: Partial<ToolInvocationRecord> = {},
): ToolInvocationRecord {
  return {
    toolCallId: "call-1",
    toolName: "read_file",
    status: "success",
    resultSummary: "read ok",
    artifactId: "art-tool-1",
    mediaType: "text/plain",
    contentSizeChars: 50,
    ...overrides,
  };
}

function turnRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: "turn-1",
    startedAt: "2026-01-01T12:00:00.000Z",
    importance: "normal",
    userMessage: { role: "user", content: "Do the thing" },
    entries: [],
    ...overrides,
  };
}

function pinnedRecord(
  overrides: Partial<PinnedMemoryRecord> = {},
): PinnedMemoryRecord {
  return {
    id: "pin-1",
    kind: "fact",
    scope: "session",
    content: "Remember this",
    source: { origin: "user" },
    createdAt: "2026-01-01T12:00:00.000Z",
    updatedAt: "2026-01-01T12:30:00.000Z",
    lifecycle: "active",
    ...overrides,
  };
}

function rollingSummary(
  overrides: Partial<RollingSummaryRecord> = {},
): RollingSummaryRecord {
  return {
    content: "Earlier we discussed setup.",
    updatedAt: "2026-01-02T10:00:00.000Z",
    coveredTurnIds: ["turn-old-1", "turn-old-2"],
    estimatedTokens: 42,
    ...overrides,
  };
}

function promptPlan(overrides: Partial<PromptPlan> = {}): PromptPlan {
  return {
    messages: [],
    estimatedPromptTokens: 1000,
    reservedOutputTokens: 2048,
    includedTurnIds: [],
    includedArtifactIds: [],
    omittedTurnIds: [],
    usedRollingSummary: false,
    retryLevel: 0,
    ...overrides,
  };
}

function promptPlanSnapshot(
  overrides: Partial<PromptPlanSnapshot> & { plan?: Partial<PromptPlan> } = {},
): PromptPlanSnapshot {
  const { plan: planOverrides, ...rest } = overrides;
  return {
    provider: "openai",
    model: "gpt-4",
    iteration: 1,
    contextWindowTokens: 128_000,
    availableInputBudget: 125_952,
    plan: promptPlan(planOverrides ?? {}),
    ...rest,
  };
}

describe("formatContextOverview", () => {
  it("produces minimal overview lines for empty state (no turns, no pinned)", () => {
    const lines = formatContextOverview(emptyConversationState());

    expect(
      lines.some((l) => l.text === "Context Overview" && l.style === "section"),
    ).toBe(true);
    expect(
      lines.some((l) => l.text === "  Turns: 0" && l.style === "info"),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text.includes("Estimated conversation tokens") &&
          l.text.includes("~0") &&
          l.text.includes("stored conversation") &&
          l.style === "info",
      ),
    ).toBe(true);
    expect(lines.some((l) => l.text.startsWith("  Preamble:"))).toBe(false);
    expect(
      lines.some((l) => l.text === "Preamble" && l.style === "section"),
    ).toBe(false);
    expect(
      lines.some(
        (l) => l.text.includes("Rolling summary: none") && l.style === "info",
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.text === "  Artifacts: 0" && l.style === "info"),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text.includes("Pinned memory:") &&
          l.text.includes("0 active") &&
          l.style === "info",
      ),
    ).toBe(true);

    expect(lines.some((l) => l.text === "Turns" && l.style === "section")).toBe(
      false,
    );
  });

  it("shows full stats for populated state with turns, artifacts, summary, and pinned", () => {
    const state = emptyConversationState({
      turns: [
        turnRecord({
          id: "t-a",
          completedAt: "2026-01-01T12:05:00.000Z",
          userMessage: { role: "user", content: "First question" },
          estimatedTokens: 100,
          entries: [
            {
              kind: "assistant",
              createdAt: "2026-01-01T12:05:01.000Z",
              message: { role: "assistant", content: "Answer one" },
            },
          ],
        }),
        turnRecord({
          id: "t-b",
          completedAt: "2026-01-01T12:10:00.000Z",
          userMessage: { role: "user", content: "Second question" },
          estimatedTokens: 200,
          entries: [
            {
              kind: "assistant",
              createdAt: "2026-01-01T12:10:01.000Z",
              message: { role: "assistant", content: "Answer two" },
            },
          ],
        }),
      ],
      artifacts: [artifact({ id: "a1" }), artifact({ id: "a2" })],
      rollingSummary: rollingSummary({
        coveredTurnIds: ["t-x"],
        estimatedTokens: 55,
      }),
      pinnedMemory: [pinnedRecord({ id: "p1" })],
    });

    const lines = formatContextOverview(state);

    expect(
      lines.some((l) => l.text === "  Turns: 2" && l.style === "info"),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text.includes("~300") &&
          l.text.includes("Estimated conversation tokens") &&
          l.text.includes("stored conversation") &&
          l.style === "info",
      ),
    ).toBe(true);
    expect(lines.some((l) => l.text.startsWith("  Preamble:"))).toBe(false);
    expect(
      lines.some((l) => l.text === "Preamble" && l.style === "section"),
    ).toBe(false);
    expect(
      lines.some(
        (l) =>
          l.text.includes("Rolling summary:") &&
          l.text.includes("~55 tokens") &&
          l.text.includes("1 turn") &&
          l.style === "info",
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.text === "  Artifacts: 2" && l.style === "info"),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text.includes("Pinned memory:") &&
          l.text.includes("1 active") &&
          l.text.includes("record") &&
          l.style === "info",
      ),
    ).toBe(true);

    expect(lines.some((l) => l.text === "Turns" && l.style === "section")).toBe(
      true,
    );
    expect(
      lines.some(
        (l) =>
          l.text.includes("[completed]") && l.text.includes("First question"),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text.includes("[completed]") && l.text.includes("Second question"),
      ),
    ).toBe(true);
  });

  it("shows preamble section and non-zero tokens when only preamble is present", () => {
    const state = emptyConversationState({
      preamble: [{ role: "assistant", content: "Welcome!" }],
    });

    const lines = formatContextOverview(state);

    expect(
      lines.some(
        (l) => l.text === "  Preamble: 1 message" && l.style === "info",
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.text === "  Turns: 0" && l.style === "info"),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text.includes("Estimated conversation tokens") &&
          l.text.includes("~2") &&
          l.text.includes("stored conversation") &&
          l.style === "info",
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.text === "Preamble" && l.style === "section"),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text.includes("ASSISTANT: Welcome!") && l.style === "info",
      ),
    ).toBe(true);
    expect(lines.some((l) => l.text === "Turns" && l.style === "section")).toBe(
      false,
    );
  });

  it("shows both Preamble and Turns sections and sums preamble and turn tokens", () => {
    const state = emptyConversationState({
      preamble: [{ role: "assistant", content: "Welcome!" }],
      turns: [
        turnRecord({
          id: "t1",
          completedAt: "2026-01-01T12:00:00.000Z",
          userMessage: { role: "user", content: "Hi" },
          estimatedTokens: 100,
          entries: [],
        }),
      ],
    });

    const lines = formatContextOverview(state);

    expect(
      lines.some(
        (l) => l.text === "  Preamble: 1 message" && l.style === "info",
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.text === "Preamble" && l.style === "section"),
    ).toBe(true);
    expect(lines.some((l) => l.text === "Turns" && l.style === "section")).toBe(
      true,
    );
    expect(
      lines.some(
        (l) =>
          l.text.includes("~102") &&
          l.text.includes("Estimated conversation tokens") &&
          l.text.includes("stored conversation") &&
          l.style === "info",
      ),
    ).toBe(true);
  });

  it("labels a turn without completedAt as in-progress", () => {
    const state = emptyConversationState({
      turns: [
        turnRecord({
          completedAt: undefined,
          userMessage: { role: "user", content: "Still going" },
        }),
      ],
    });

    const lines = formatContextOverview(state);
    expect(
      lines.some(
        (l) =>
          l.text.includes("[in-progress]") && l.text.includes("Still going"),
      ),
    ).toBe(true);
  });

  it("shows tool names and success/error status for tool invocations", () => {
    const state = emptyConversationState({
      turns: [
        turnRecord({
          completedAt: "2026-01-01T12:00:00.000Z",
          userMessage: { role: "user", content: "Run tools" },
          entries: [
            {
              kind: "assistant",
              createdAt: "2026-01-01T12:00:01.000Z",
              message: { role: "assistant", content: "Calling tools" },
            },
            {
              kind: "tool",
              createdAt: "2026-01-01T12:00:02.000Z",
              message: { role: "tool", content: "", toolResults: [] },
              toolInvocations: [
                toolInvocation({ toolName: "grep", status: "success" }),
                toolInvocation({
                  toolCallId: "call-2",
                  toolName: "run_cmd",
                  status: "error",
                  artifactId: "art-e",
                }),
              ],
            },
          ],
        }),
      ],
    });

    const lines = formatContextOverview(state);
    const detailLine = lines.find(
      (l) => l.style === "subtle" && l.text.includes("tools:"),
    );
    expect(detailLine).toBeDefined();
    expect(detailLine!.text).toContain("grep");
    expect(detailLine!.text).toContain("run_cmd");
    expect(detailLine!.text).toContain("1 ok");
    expect(detailLine!.text).toContain("1 failed");
  });
});

describe("formatContextStats", () => {
  it("shows zeros for empty state", () => {
    const s = formatContextStats(emptyConversationState());
    expect(s).toContain("0 turns");
    expect(s).toContain("~0 conversation tokens");
    expect(s).toContain("0 artifacts");
    expect(s).toContain("summary ~0 tokens");
    expect(s).toContain("0 pinned");
  });

  it("produces a compact string with correct counts for populated state", () => {
    const state = emptyConversationState({
      turns: [
        turnRecord({
          id: "x",
          estimatedTokens: 10,
          completedAt: "2026-01-01T00:00:00.000Z",
        }),
        turnRecord({
          id: "y",
          estimatedTokens: 20,
          completedAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
      artifacts: [artifact()],
      rollingSummary: rollingSummary({ estimatedTokens: 99 }),
      pinnedMemory: [
        pinnedRecord(),
        pinnedRecord({ id: "p2", lifecycle: "removed" }),
      ],
    });

    const s = formatContextStats(state);
    expect(s).toContain("2 turns");
    expect(s).not.toContain("preamble +");
    expect(s).toContain("~30 conversation tokens");
    expect(s).toContain("1 artifact");
    expect(s).toContain("summary ~99 tokens");
    expect(s).toContain("1 pinned");
  });

  it("prefixes turn count with preamble count when preamble exists", () => {
    const state = emptyConversationState({
      preamble: [{ role: "assistant", content: "Welcome!" }],
      turns: [
        turnRecord({
          id: "x",
          estimatedTokens: 10,
          completedAt: "2026-01-01T00:00:00.000Z",
        }),
        turnRecord({
          id: "y",
          estimatedTokens: 20,
          completedAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
    });

    const s = formatContextStats(state);
    expect(s).toContain("1 preamble + 2 turns");
    expect(s).toContain("~32 conversation tokens");
  });
});

describe("formatPromptPlan", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are helpful." },
    {
      role: "user",
      content: "Please search the repo for TODO markers across many files.",
    },
    {
      role: "assistant",
      content: "I will run grep.",
      toolCalls: [
        {
          id: "t1",
          function: { name: "grep", arguments: { pattern: "TODO" } },
        },
      ],
    },
    {
      role: "tool",
      content: "",
      toolResults: [
        {
          toolCallId: "t1",
          toolName: "grep",
          content: "found in a.ts",
        },
      ],
    },
  ];

  it("includes provider, model, iteration, budget, retry label, turn counts, and message previews", () => {
    const snapshot = promptPlanSnapshot({
      provider: "anthropic",
      model: "claude-3",
      iteration: 4,
      contextWindowTokens: 200_000,
      availableInputBudget: 197_000,
      plan: {
        messages,
        estimatedPromptTokens: 12_345,
        reservedOutputTokens: 4096,
        includedTurnIds: ["t1", "t2"],
        omittedTurnIds: ["old-1"],
        includedArtifactIds: ["art-a", "art-b"],
        usedRollingSummary: true,
        retryLevel: 1,
      },
    });

    const lines = formatPromptPlan(snapshot);

    expect(
      lines.some((l) => l.text === "Prompt Plan" && l.style === "section"),
    ).toBe(true);
    expect(lines.some((l) => l.text.includes("Provider: anthropic"))).toBe(
      true,
    );
    expect(lines.some((l) => l.text.includes("Model: claude-3"))).toBe(true);
    expect(lines.some((l) => l.text.includes("Iteration: 4"))).toBe(true);
    expect(
      lines.some((l) => l.text.includes("Context window: 200000 tokens")),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.text.includes("Available input budget: 197000 tokens"),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.text.includes("~12345"))).toBe(true);
    expect(
      lines.some((l) => l.text.includes("Reserved output tokens: 4096")),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text.includes("Retry level: 1") &&
          l.text.includes("fewer historical turns"),
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.text.includes("Included turns: 2 (t1, t2)")),
    ).toBe(true);
    expect(lines.some((l) => l.text.includes("Omitted turns: 1 (old-1)"))).toBe(
      true,
    );
    expect(
      lines.some((l) =>
        l.text.includes("Inlined artifacts: 2 (art-a, art-b)"),
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.text.includes("Used rolling summary: yes")),
    ).toBe(true);

    expect(
      lines.some((l) => l.text === "Prompt Messages" && l.style === "section"),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text.startsWith("  SYSTEM:") &&
          l.text.includes("You are helpful.") &&
          l.style === "subtle",
      ),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text.startsWith("  USER:") &&
          l.text.includes("TODO markers") &&
          l.style === "subtle",
      ),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text.startsWith("  ASSISTANT:") &&
          l.text.includes("[+1 tool call]") &&
          l.style === "subtle",
      ),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text.startsWith("  TOOL:") &&
          l.text.includes("[1 tool result]") &&
          l.style === "subtle",
      ),
    ).toBe(true);
  });

  it("shows minimal prompt label for retry level 3", () => {
    const snapshot = promptPlanSnapshot({
      plan: {
        messages: [],
        retryLevel: 3,
        estimatedPromptTokens: 100,
        reservedOutputTokens: 512,
        includedTurnIds: [],
        includedArtifactIds: [],
        omittedTurnIds: [],
        usedRollingSummary: false,
      },
    });

    const lines = formatPromptPlan(snapshot);
    expect(
      lines.some(
        (l) =>
          l.text.includes("Retry level: 3") &&
          l.text.includes("minimal prompt (system + current turn only)"),
      ),
    ).toBe(true);
  });

  it("annotates multiple tool calls and tool results", () => {
    const snapshot = promptPlanSnapshot({
      plan: {
        messages: [
          {
            role: "assistant",
            content: "x",
            toolCalls: [
              { function: { name: "a", arguments: {} } },
              { function: { name: "b", arguments: {} } },
            ],
          },
          {
            role: "tool",
            content: "",
            toolResults: [
              { toolCallId: "1", toolName: "a", content: "1" },
              { toolCallId: "2", toolName: "b", content: "2" },
            ],
          },
        ],
        estimatedPromptTokens: 1,
        reservedOutputTokens: 1,
        includedTurnIds: [],
        includedArtifactIds: [],
        omittedTurnIds: [],
        usedRollingSummary: false,
        retryLevel: 0,
      },
    });

    const lines = formatPromptPlan(snapshot);
    expect(lines.some((l) => l.text.includes("[+2 tool calls]"))).toBe(true);
    expect(lines.some((l) => l.text.includes("[2 tool results]"))).toBe(true);
  });
});

describe("formatPromptPlanCompact", () => {
  it("produces a single line with key metrics", () => {
    const snapshot = promptPlanSnapshot({
      provider: "bedrock",
      model: "model-id",
      iteration: 2,
      plan: {
        estimatedPromptTokens: 5000,
        includedTurnIds: ["a", "b", "c"],
        omittedTurnIds: ["z"],
        usedRollingSummary: false,
        retryLevel: 2,
        messages: [],
        reservedOutputTokens: 1024,
        includedArtifactIds: [],
      },
    });

    const line = formatPromptPlanCompact(snapshot);
    expect(line.split("\n").length).toBe(1);
    expect(line).toContain("bedrock/model-id");
    expect(line).toContain("iter=2");
    expect(line).toContain("~5000 prompt tokens");
    expect(line).toContain("3 included, 1 omitted");
    expect(line).toContain("retry=2");
    expect(line).toContain("tighter artifact/content caps");
    expect(line).toContain("summary=no");
  });
});

describe("formatMemoryView", () => {
  it("shows placeholders when there is no summary and no active pinned memory", () => {
    const lines = formatMemoryView(
      emptyConversationState({
        pinnedMemory: [
          pinnedRecord({ lifecycle: "superseded", supersededById: "x" }),
        ],
      }),
    );

    expect(
      lines.some((l) => l.text === "Memory & Summary" && l.style === "section"),
    ).toBe(true);
    expect(
      lines.some(
        (l) => l.text === "  No rolling summary yet." && l.style === "subtle",
      ),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.text === "  No active pinned memory records." &&
          l.style === "subtle",
      ),
    ).toBe(true);
  });

  it("renders rolling summary and active pinned records with all displayed fields", () => {
    const state = emptyConversationState({
      rollingSummary: rollingSummary({
        content: "Line one\nLine two",
        coveredTurnIds: ["c1", "c2"],
        estimatedTokens: 77,
        updatedAt: "2026-03-01T08:00:00.000Z",
      }),
      pinnedMemory: [
        pinnedRecord({
          kind: "constraint",
          scope: "project",
          content: "Use ESM imports",
          source: { origin: "assistant", turnId: "t-99" },
          rationale: "User asked for NodeNext",
          createdAt: "2026-03-01T09:00:00.000Z",
          updatedAt: "2026-03-01T09:30:00.000Z",
          lifecycle: "active",
        }),
      ],
    });

    const lines = formatMemoryView(state);

    expect(
      lines.some((l) => l.text.includes("Covered turns: 2 (c1, c2)")),
    ).toBe(true);
    expect(
      lines.some(
        (l) => l.text.includes("~77") && l.text.includes("(estimated)"),
      ),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.text.includes("Updated at: 2026-03-01T08:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.text === "    Line one" && l.style === "subtle"),
    ).toBe(true);
    expect(
      lines.some((l) => l.text === "    Line two" && l.style === "subtle"),
    ).toBe(true);

    expect(
      lines.some(
        (l) =>
          l.text.includes("[constraint]") &&
          l.text.includes("(project)") &&
          l.text.includes("Use ESM imports") &&
          l.style === "info",
      ),
    ).toBe(true);

    const detail = lines.find(
      (l) =>
        l.style === "subtle" &&
        l.text.includes("source: assistant") &&
        l.text.includes("rationale:"),
    );
    expect(detail).toBeDefined();
    expect(detail!.text).toContain("lifecycle: active");
    expect(detail!.text).toContain("created: 2026-03-01T09:00:00.000Z");
    expect(detail!.text).toContain("User asked for NodeNext");
  });
});
