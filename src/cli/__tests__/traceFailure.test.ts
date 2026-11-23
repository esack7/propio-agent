import { foregroundTraceHint } from "../sessionInspection.js";

test("allocation failure gives structured unavailable metadata without invented identity", () => {
  const result = foregroundTraceHint("/nonexistent/trace-root", {
    sessionId: "session",
  });
  expect(
    JSON.parse(
      JSON.stringify({ error: "original provider error", trace: result }),
    ),
  ).toEqual({ error: "original provider error", trace: { available: false } });
});

test("inspection failure never throws or exposes a stale show command", () => {
  expect(
    foregroundTraceHint("/nonexistent/trace-root", {
      sessionId: "session",
      runId: "missing",
    }),
  ).toEqual({ available: false });
});

test("readable foreground failure supplies an exact shell-safe offline command", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trace-failure-"));
  try {
    fs.mkdirSync(path.join(root, "session"));
    fs.writeFileSync(
      path.join(root, "session", "foreground.jsonl"),
      JSON.stringify({
        version: 1,
        eventId: "event",
        sequence: 1,
        observedAt: "2026-11-15T00:00:00.000Z",
        monotonicNanoseconds: "1",
        component: "agent",
        type: "turn_failed",
        identity: {
          sessionId: "session",
          runId: "foreground",
          operationId: "turn",
        },
        payload: { error: "original" },
      }) + "\n",
    );
    expect(
      foregroundTraceHint(root, { sessionId: "session", runId: "foreground" }),
    ).toMatchObject({
      available: true,
      runId: "foreground",
      command: "propio trace show 'foreground' --session 'session'",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "noninteractive failure preserves original error (json=%s)",
  async (json) => {
    const { runNonInteractiveSession } = await import("../../index.js");
    const { TerminalUi } = await import("../../ui/terminal.js");
    const { createMockWriteStream } =
      await import("../../__tests__/testHelpers.js");
    const stdout = createMockWriteStream();
    const stderr = createMockWriteStream();
    const ui = new TerminalUi({
      interactive: false,
      plain: true,
      json,
      stdout,
      stderr,
    });
    const agent = {
      getSessionTraceIdentity: () => ({
        sessionId: "session",
        runId: "previous-success",
      }),
      streamChat: async () => {
        throw new Error("original failure");
      },
      getLastTurnReasoningSummary: () => null,
      getConversationState: () => ({
        preamble: [],
        turns: [],
        artifacts: [],
        pinnedMemory: [],
        invokedSkills: [],
        rollingSummary: null,
      }),
    } as unknown as import("../../agent.js").Agent;
    const code = await runNonInteractiveSession(
      agent,
      ui,
      () => {},
      {
        showToolCalls: false,
        showThinking: false,
        showStatus: false,
        showReasoningSummary: false,
        showContextStats: false,
        showPromptPlan: false,
      },
      { stdinIsTTY: false, readInput: async () => "hello" },
    );
    expect(code).toBe(1);
    if (json)
      expect(JSON.parse(stdout.chunks.join(""))).toEqual({
        error: "original failure",
        trace: { available: false },
      });
    else {
      expect(stderr.chunks.join("")).toContain("original failure");
      expect([...stdout.chunks, ...stderr.chunks].join("")).not.toContain(
        "previous-success",
      );
    }
  },
);

test("interactive pre-turn failure cannot identify the previous turn", async () => {
  const { runInteractiveTurn } = await import("../../index.js");
  const { TerminalUi } = await import("../../ui/terminal.js");
  const { createMockWriteStream } =
    await import("../../__tests__/testHelpers.js");
  const { PassThrough } = await import("node:stream");
  const { createPlainSubmission } =
    await import("../../ui/input/promptSubmission.js");
  const stdout = createMockWriteStream();
  const stderr = createMockWriteStream();
  const ui = new TerminalUi({
    interactive: false,
    plain: true,
    json: false,
    stdout,
    stderr,
  });
  const agent = {
    getSessionTraceIdentity: () => ({
      sessionId: "session",
      runId: "previous-success",
    }),
  } as unknown as import("../../agent.js").Agent;
  await runInteractiveTurn(
    createPlainSubmission("hello", "prompt"),
    {
      agent,
      ui,
      composer: {} as never,
      configPath: "unused",
      inputStream: new PassThrough() as never,
      interactiveInput: false,
      setCurrentAbortController: () => {},
      cancelActiveTurn: () => {},
      shouldExit: () => false,
      getVisibility: () => ({
        showToolCalls: false,
        showThinking: false,
        showStatus: false,
        showReasoningSummary: false,
        showContextStats: false,
        showPromptPlan: false,
      }),
    },
    {
      beforeTurn: async () => {
        throw new Error("missing skill");
      },
      errorPrefix: "Error: ",
    },
  );
  const output = [...stdout.chunks, ...stderr.chunks].join("");
  expect(output).toContain("missing skill");
  expect(output).toContain("No usable foreground trace");
  expect(output).not.toContain("previous-success");
});
