import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  hasSessionContent,
  formatSessionEntry,
  saveSessionOnExit,
  handleSessionCommand,
  SessionAgent,
  SessionCommandIO,
} from "../sessionCommands.js";
import { writeSnapshot } from "../sessionHistory.js";
import { ConversationState } from "../../context/types.js";
import { SessionIndexEntry } from "../sessionHistory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

function freshDir(): string {
  return fs.mkdtempSync(path.join(tmpRoot, "sess-cmd-"));
}

const EMPTY_STATE: ConversationState = {
  preamble: [],
  turns: [],
  artifacts: [],
  pinnedMemory: [],
};

function stateWithTurns(count: number): ConversationState {
  const turns = Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    importance: "normal" as const,
    userMessage: { role: "user" as const, content: `msg ${i}` },
    entries: [
      {
        kind: "assistant" as const,
        createdAt: new Date().toISOString(),
        message: { role: "assistant" as const, content: `reply ${i}` },
      },
    ],
  }));
  return { ...EMPTY_STATE, turns };
}

function stateWithPinnedMemoryOnly(): ConversationState {
  return {
    ...EMPTY_STATE,
    pinnedMemory: [
      {
        id: "pm-1",
        kind: "fact",
        scope: "session",
        content: "Test fact",
        source: { origin: "user" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lifecycle: "active",
      },
    ],
  };
}

function stateWithRollingSummaryOnly(): ConversationState {
  return {
    ...EMPTY_STATE,
    rollingSummary: {
      content: "Summary of earlier turns",
      updatedAt: new Date().toISOString(),
      coveredTurnIds: ["old-1"],
      estimatedTokens: 20,
    },
  };
}

function stateWithArtifactsOnly(): ConversationState {
  return {
    ...EMPTY_STATE,
    artifacts: [
      {
        id: "a-1",
        type: "tool_result",
        mediaType: "text/plain",
        createdAt: new Date().toISOString(),
        content: "artifact content",
        contentSizeChars: 16,
        referencingTurnIds: [],
      },
    ],
  };
}

function minimalSessionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    savedAt: overrides.savedAt ?? new Date().toISOString(),
    metadata: {
      providerName: overrides.providerName ?? "test-provider",
      modelKey: overrides.modelKey ?? "test-model",
      systemPrompt: "Test.",
      promptBudgetPolicy: {
        reservedOutputTokens: 2048,
        maxRecentTurns: 50,
        artifactInlineCharCap: 12000,
      },
      summaryPolicy: {
        rawRecentTurns: 6,
        refreshIntervalTurns: 3,
        summaryTargetTokens: 512,
        contextPressureThreshold: 0.6,
      },
      contextWindowTokens: 128000,
    },
    context: {
      preamble: [],
      turns: overrides.turns ?? [],
      artifacts: [],
      pinnedMemory: overrides.pinnedMemory ?? [],
      ...(overrides.rollingSummary !== undefined
        ? { rollingSummary: overrides.rollingSummary }
        : {}),
    },
  });
}

function makeTurn(id: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    startedAt: now,
    completedAt: now,
    importance: "normal",
    userMessage: { role: "user", content: `msg ${id}` },
    entries: [
      {
        kind: "assistant",
        createdAt: now,
        message: { role: "assistant", content: `reply ${id}` },
      },
    ],
  };
}

function createMockAgent(state: ConversationState): SessionAgent {
  let currentState = state;
  return {
    getConversationState: () => currentState,
    exportSession: () =>
      minimalSessionJson({
        turns: currentState.turns.map((t) => makeTurn(t.id)),
        pinnedMemory: currentState.pinnedMemory,
        rollingSummary: currentState.rollingSummary,
      }),
    importSession: (json: string) => {
      const parsed = JSON.parse(json);
      currentState = {
        preamble: [],
        turns: parsed.context.turns,
        artifacts: parsed.context.artifacts ?? [],
        pinnedMemory: parsed.context.pinnedMemory ?? [],
        rollingSummary: parsed.context.rollingSummary,
      };
    },
  };
}

function createMockIO(confirmResult: boolean = false): SessionCommandIO & {
  messages: Array<{ type: string; message: string }>;
  confirmCalled: boolean;
} {
  const messages: Array<{ type: string; message: string }> = [];
  let confirmCalled = false;
  return {
    messages,
    get confirmCalled() {
      return confirmCalled;
    },
    info: (msg) => messages.push({ type: "info", message: msg }),
    error: (msg) => messages.push({ type: "error", message: msg }),
    success: (msg) => messages.push({ type: "success", message: msg }),
    command: (msg) => messages.push({ type: "command", message: msg }),
    promptConfirm: async () => {
      confirmCalled = true;
      return confirmResult;
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "propio-cmd-test-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hasSessionContent", () => {
  it("should return false for completely empty state", () => {
    expect(hasSessionContent(EMPTY_STATE)).toBe(false);
  });

  it("should return true when turns exist", () => {
    expect(hasSessionContent(stateWithTurns(1))).toBe(true);
  });

  it("should return true when preamble exists", () => {
    const state: ConversationState = {
      ...EMPTY_STATE,
      preamble: [{ role: "system", content: "preamble" }],
    };
    expect(hasSessionContent(state)).toBe(true);
  });

  it("should return true when only pinned memory exists", () => {
    expect(hasSessionContent(stateWithPinnedMemoryOnly())).toBe(true);
  });

  it("should return true when only rolling summary exists", () => {
    expect(hasSessionContent(stateWithRollingSummaryOnly())).toBe(true);
  });

  it("should return true when only artifacts exist", () => {
    expect(hasSessionContent(stateWithArtifactsOnly())).toBe(true);
  });
});

describe("formatSessionEntry", () => {
  it("should format a single-turn entry", () => {
    const entry: SessionIndexEntry = {
      sessionId: "2026-03-29T10-00-00.000Z-abc123",
      snapshotFile: "2026-03-29T10-00-00.000Z-abc123.json",
      savedAt: "2026-03-29T10:00:00.000Z",
      providerName: "openrouter",
      modelKey: "gpt-4o",
      turnCount: 1,
      hasRollingSummary: false,
    };
    const formatted = formatSessionEntry(entry);
    expect(formatted).toContain("2026-03-29T10-00-00.000Z-abc123");
    expect(formatted).toContain("openrouter/gpt-4o");
    expect(formatted).toContain("1 turn");
    expect(formatted).not.toContain("has summary");
  });

  it("should include summary indicator when present", () => {
    const entry: SessionIndexEntry = {
      sessionId: "test-id",
      snapshotFile: "test-id.json",
      savedAt: "2026-03-29T10:00:00.000Z",
      providerName: "prov",
      modelKey: "mod",
      turnCount: 5,
      hasRollingSummary: true,
    };
    const formatted = formatSessionEntry(entry);
    expect(formatted).toContain("5 turns");
    expect(formatted).toContain("has summary");
  });
});

describe("saveSessionOnExit", () => {
  it("should save when session has turns", () => {
    const dir = freshDir();
    const agent = createMockAgent(stateWithTurns(2));
    const io = createMockIO();

    saveSessionOnExit(agent, dir, io);

    const infoMsgs = io.messages.filter((m) => m.type === "info");
    expect(infoMsgs).toHaveLength(1);
    expect(infoMsgs[0].message).toMatch(/Session saved:.*2 turns/);

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") && f !== "index.json");
    expect(files).toHaveLength(1);
  });

  it("should save when session has only pinned memory", () => {
    const dir = freshDir();
    const agent = createMockAgent(stateWithPinnedMemoryOnly());
    const io = createMockIO();

    saveSessionOnExit(agent, dir, io);

    const infoMsgs = io.messages.filter((m) => m.type === "info");
    expect(infoMsgs).toHaveLength(1);
    expect(infoMsgs[0].message).toContain("Session saved:");
  });

  it("should save when session has only rolling summary", () => {
    const dir = freshDir();
    const agent = createMockAgent(stateWithRollingSummaryOnly());
    const io = createMockIO();

    saveSessionOnExit(agent, dir, io);

    const infoMsgs = io.messages.filter((m) => m.type === "info");
    expect(infoMsgs).toHaveLength(1);
    expect(infoMsgs[0].message).toContain("Session saved:");
  });

  it("should save when session has only artifacts", () => {
    const dir = freshDir();
    const agent = createMockAgent(stateWithArtifactsOnly());
    const io = createMockIO();

    saveSessionOnExit(agent, dir, io);

    const infoMsgs = io.messages.filter((m) => m.type === "info");
    expect(infoMsgs).toHaveLength(1);
    expect(infoMsgs[0].message).toContain("Session saved:");
  });

  it("should skip saving when session is completely empty", () => {
    const dir = path.join(freshDir(), "sessions");
    const agent = createMockAgent(EMPTY_STATE);
    const io = createMockIO();

    saveSessionOnExit(agent, dir, io);

    expect(io.messages).toHaveLength(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("should report error without crashing on write failure", () => {
    const agent = createMockAgent(stateWithTurns(1));
    const io = createMockIO();

    saveSessionOnExit(agent, "/nonexistent/root/path/sessions", io);

    const errors = io.messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Failed to save session");
  });
});

describe("handleSessionCommand — /session list", () => {
  it("should show 'No saved sessions' for empty directory", async () => {
    const dir = freshDir();
    const agent = createMockAgent(EMPTY_STATE);
    const io = createMockIO();

    await handleSessionCommand("/session list", agent, dir, io);

    const infoMsgs = io.messages.filter((m) => m.type === "info");
    expect(infoMsgs.some((m) => m.message === "No saved sessions.")).toBe(true);
  });

  it("should list sessions newest-first", async () => {
    const dir = freshDir();
    writeSnapshot(
      dir,
      minimalSessionJson({
        savedAt: "2026-03-29T08:00:00.000Z",
        providerName: "oldest",
      }),
    );
    writeSnapshot(
      dir,
      minimalSessionJson({
        savedAt: "2026-03-29T12:00:00.000Z",
        providerName: "newest",
      }),
    );

    const agent = createMockAgent(EMPTY_STATE);
    const io = createMockIO();

    await handleSessionCommand("/session list", agent, dir, io);

    const cmdMsgs = io.messages
      .filter((m) => m.type === "command")
      .map((m) => m.message)
      .filter((m) => m.length > 0);
    expect(cmdMsgs).toHaveLength(2);
    expect(cmdMsgs[0]).toContain("newest");
    expect(cmdMsgs[1]).toContain("oldest");
  });
});

describe("handleSessionCommand — /session load", () => {
  it("should load the latest session when no ID given", async () => {
    const dir = freshDir();
    writeSnapshot(
      dir,
      minimalSessionJson({
        savedAt: "2026-03-29T08:00:00.000Z",
        turns: [makeTurn("old")],
      }),
    );
    const newest = writeSnapshot(
      dir,
      minimalSessionJson({
        savedAt: "2026-03-29T12:00:00.000Z",
        turns: [makeTurn("new1"), makeTurn("new2")],
      }),
    );

    const agent = createMockAgent(EMPTY_STATE);
    const io = createMockIO();

    await handleSessionCommand("/session load", agent, dir, io);

    const successMsgs = io.messages.filter((m) => m.type === "success");
    expect(successMsgs).toHaveLength(1);
    expect(successMsgs[0].message).toContain(newest.sessionId);
    expect(successMsgs[0].message).toContain("2 turns");
  });

  it("should load a specific session by ID", async () => {
    const dir = freshDir();
    const target = writeSnapshot(
      dir,
      minimalSessionJson({
        savedAt: "2026-03-29T08:00:00.000Z",
        turns: [makeTurn("t1")],
      }),
    );
    writeSnapshot(
      dir,
      minimalSessionJson({
        savedAt: "2026-03-29T12:00:00.000Z",
        turns: [makeTurn("t2"), makeTurn("t3")],
      }),
    );

    const agent = createMockAgent(EMPTY_STATE);
    const io = createMockIO();

    await handleSessionCommand(
      `/session load ${target.sessionId}`,
      agent,
      dir,
      io,
    );

    const successMsgs = io.messages.filter((m) => m.type === "success");
    expect(successMsgs).toHaveLength(1);
    expect(successMsgs[0].message).toContain(target.sessionId);
    expect(successMsgs[0].message).toContain("1 turn");
  });

  it("should error when loading a nonexistent session ID", async () => {
    const dir = freshDir();
    writeSnapshot(dir, minimalSessionJson());

    const agent = createMockAgent(EMPTY_STATE);
    const io = createMockIO();

    await handleSessionCommand("/session load nonexistent-id", agent, dir, io);

    const errors = io.messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Session not found: nonexistent-id");
  });

  it("should error when loading from empty history", async () => {
    const dir = freshDir();
    const agent = createMockAgent(EMPTY_STATE);
    const io = createMockIO();

    await handleSessionCommand("/session load", agent, dir, io);

    const errors = io.messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("No saved sessions to load.");
  });

  it("should prompt confirmation when live session has turns", async () => {
    const dir = freshDir();
    writeSnapshot(dir, minimalSessionJson({ turns: [makeTurn("t1")] }));

    const agent = createMockAgent(stateWithTurns(1));
    const io = createMockIO(false);

    await handleSessionCommand("/session load", agent, dir, io);

    expect(io.confirmCalled).toBe(true);
    const infoMsgs = io.messages.filter((m) => m.type === "info");
    expect(infoMsgs.some((m) => m.message === "Load cancelled.")).toBe(true);
  });

  it("should prompt confirmation when live session has only pinned memory", async () => {
    const dir = freshDir();
    writeSnapshot(dir, minimalSessionJson({ turns: [makeTurn("t1")] }));

    const agent = createMockAgent(stateWithPinnedMemoryOnly());
    const io = createMockIO(false);

    await handleSessionCommand("/session load", agent, dir, io);

    expect(io.confirmCalled).toBe(true);
    const infoMsgs = io.messages.filter((m) => m.type === "info");
    expect(infoMsgs.some((m) => m.message === "Load cancelled.")).toBe(true);
  });

  it("should prompt confirmation when live session has only rolling summary", async () => {
    const dir = freshDir();
    writeSnapshot(dir, minimalSessionJson({ turns: [makeTurn("t1")] }));

    const agent = createMockAgent(stateWithRollingSummaryOnly());
    const io = createMockIO(false);

    await handleSessionCommand("/session load", agent, dir, io);

    expect(io.confirmCalled).toBe(true);
  });

  it("should prompt confirmation when live session has only artifacts", async () => {
    const dir = freshDir();
    writeSnapshot(dir, minimalSessionJson({ turns: [makeTurn("t1")] }));

    const agent = createMockAgent(stateWithArtifactsOnly());
    const io = createMockIO(false);

    await handleSessionCommand("/session load", agent, dir, io);

    expect(io.confirmCalled).toBe(true);
  });

  it("should proceed when confirmation is accepted", async () => {
    const dir = freshDir();
    writeSnapshot(dir, minimalSessionJson({ turns: [makeTurn("t1")] }));

    const agent = createMockAgent(stateWithTurns(1));
    const io = createMockIO(true);

    await handleSessionCommand("/session load", agent, dir, io);

    expect(io.confirmCalled).toBe(true);
    const successMsgs = io.messages.filter((m) => m.type === "success");
    expect(successMsgs).toHaveLength(1);
    expect(successMsgs[0].message).toContain("Loaded session:");
  });

  it("should skip confirmation when live session is empty", async () => {
    const dir = freshDir();
    writeSnapshot(dir, minimalSessionJson({ turns: [makeTurn("t1")] }));

    const agent = createMockAgent(EMPTY_STATE);
    const io = createMockIO(false);

    await handleSessionCommand("/session load", agent, dir, io);

    expect(io.confirmCalled).toBe(false);
    const successMsgs = io.messages.filter((m) => m.type === "success");
    expect(successMsgs).toHaveLength(1);
  });

  it("should keep current state on load failure (invalid snapshot)", async () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "bad-snapshot.json"),
      "not valid json",
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify({
        entries: [
          {
            sessionId: "bad-snapshot",
            snapshotFile: "bad-snapshot.json",
            savedAt: "2026-01-01T00:00:00Z",
            providerName: "p",
            modelKey: "m",
            turnCount: 1,
            hasRollingSummary: false,
          },
        ],
      }),
      "utf8",
    );

    const originalState = stateWithTurns(3);
    const agent = createMockAgent(originalState);
    const io = createMockIO(true);

    await handleSessionCommand("/session load bad-snapshot", agent, dir, io);

    const errors = io.messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Failed to load session");
    expect(agent.getConversationState().turns).toHaveLength(3);
  });
});

describe("handleSessionCommand — unknown subcommand", () => {
  it("should report error for unknown subcommand", async () => {
    const dir = freshDir();
    const agent = createMockAgent(EMPTY_STATE);
    const io = createMockIO();

    await handleSessionCommand("/session delete", agent, dir, io);

    const errors = io.messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Unknown /session subcommand");
  });

  it("should report error for bare /session", async () => {
    const dir = freshDir();
    const agent = createMockAgent(EMPTY_STATE);
    const io = createMockIO();

    await handleSessionCommand("/session", agent, dir, io);

    const errors = io.messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
  });
});
