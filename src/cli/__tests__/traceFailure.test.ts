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
