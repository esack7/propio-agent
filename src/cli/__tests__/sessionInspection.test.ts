import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  inspectSessionUsage,
  sessionInspectionLines,
} from "../sessionInspection.js";
import { runTraceCommand } from "../traceCommand.js";
import { getSlashCommandCompletionCommands } from "../../ui/slashCommands.js";

let root: string;
beforeEach(() => {
  root = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "session-inspection-")),
    "traces",
  );
  fs.mkdirSync(root);
});
afterEach(() =>
  fs.rmSync(path.dirname(root), { recursive: true, force: true }),
);

test("idle inspection has explicit empty state and registered slash commands", () => {
  expect(
    sessionInspectionLines(root, { sessionId: "session" }, "/trace"),
  ).toEqual(["No foreground trace available yet."]);
  expect(inspectSessionUsage(root, "session").runs).toEqual([]);
  expect(getSlashCommandCompletionCommands().map((c) => c.command)).toEqual(
    expect.arrayContaining(["/trace", "/usage"]),
  );
});

test("session usage preserves incomplete journals and excludes other sessions", () => {
  for (const session of ["current", "other"]) {
    fs.mkdirSync(path.join(root, session));
    fs.writeFileSync(path.join(root, session, "run.jsonl"), "{unfinished");
  }
  const usage = inspectSessionUsage(root, "current");
  expect(usage.runs).toHaveLength(1);
  expect(usage.warnings.length).toBeGreaterThan(0);
  expect(usage.warnings.every((warning) => warning.startsWith("run:"))).toBe(
    true,
  );
  expect(usage.measurements.usage.usage).toBeUndefined();
  expect(
    sessionInspectionLines(root, { sessionId: "current" }, "/usage").join("\n"),
  ).not.toMatch(/Cost:|estimated=/);
});

function writeUsageJournals() {
  fs.mkdirSync(path.join(root, "session"));
  for (const runId of ["foreground", "summary"]) {
    const events = [
      { component: "agent", type: "turn_started", payload: {} },
      ...[1, 2].flatMap((attemptNumber) => {
        const base = {
          version: 1,
          provider: "fixture",
          requestedModel: "model",
          trace: {
            requestId: "shared-request",
            purpose: runId === "summary" ? "summarize" : "answer",
          },
          attemptId: `attempt-${attemptNumber}`,
          attemptNumber,
        };
        return [
          {
            component: "provider",
            type: "provider_attempt_started",
            payload: { ...base, type: "provider_attempt_started" },
          },
          ...[1, 2].map(() => ({
            component: "provider",
            type: "provider_usage_reported",
            payload: {
              ...base,
              type: "provider_usage_reported",
              availability: "reported",
              usage: {
                inputTokens: 10,
                outputTokens: 2,
                reasoningTokens: 1,
                cacheReadInputTokens: 3,
              },
              reportKind: "cumulative",
            },
          })),
          {
            component: "provider",
            type: "provider_attempt_completed",
            payload: { ...base, type: "provider_attempt_completed" },
          },
        ];
      }),
      { component: "agent", type: "turn_completed", payload: {} },
    ].map((event, i) => ({
      version: 1,
      eventId: `${runId}-${i}`,
      sequence: i + 1,
      observedAt: "2026-11-15T00:00:00.000Z",
      monotonicNanoseconds: String(i * 1000000),
      identity: { sessionId: "session", runId, operationId: "turn" },
      ...event,
    }));
    fs.writeFileSync(
      path.join(root, "session", `${runId}.jsonl`),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }
}

test("foreground and summary journals reconcile with offline snapshots", () => {
  writeUsageJournals();
  const result = inspectSessionUsage(root, "session");
  const lines = sessionInspectionLines(
    root,
    { sessionId: "session" },
    "/usage",
  ).join("\n");
  expect(lines).toContain("Purpose summarize");
  expect(lines).toContain("Model fixture/model");
  expect(lines).toContain("run=foreground request=shared-request");
  expect(lines).not.toContain("request=foreground:");
  for (const run of result.runs) {
    let output = "";
    expect(
      runTraceCommand(["show", run.runId, "--session", "session", "--json"], {
        sessionsDir: path.dirname(root),
        stdout: (text: string) => {
          output += text;
        },
        stderr: () => {},
      }),
    ).toBe(0);
    const offline = JSON.parse(output);
    expect(offline.inspection.providerMeasurements).toEqual(
      run.inspection.providerMeasurements,
    );
    expect(
      offline.timeline.every(
        (event: { observedAt: string }) =>
          event.observedAt === "2026-11-15T00:00:00.000Z",
      ),
    ).toBe(true);
  }
  expect(result.runs[0].events[0].observedAt).toBe("2026-11-15T00:00:00.000Z");
  expect(
    sessionInspectionLines(
      root,
      { sessionId: "session", runId: "foreground" },
      "/trace",
    )[0],
  ).toContain("foreground");
});

test("usage totals preserve retry, purpose and metric completeness", () => {
  writeUsageJournals();
  const result = inspectSessionUsage(root, "session");
  expect(result.measurements.requestCount).toBe(2);
  expect(result.measurements.attemptCount).toBe(4);
  for (const [metric, expected] of Object.entries({
    inputTokens: 40,
    outputTokens: 8,
    reasoningTokens: 4,
    cacheReadInputTokens: 12,
  })) {
    const key = metric as keyof NonNullable<
      typeof result.measurements.usage.usage
    >;
    expect(result.measurements.usage.usage?.[key]).toBe(expected);
    expect(result.measurements.usage.metricCompleteness[key]).toBe("complete");
    for (const purpose of result.measurements.byPurpose)
      expect(purpose.usage.usage?.[key]).toBe(expected / 2);
  }
  expect(
    result.measurements.usage.usage?.cacheWriteInputTokens,
  ).toBeUndefined();
  expect(
    result.measurements.usage.metricCompleteness.cacheWriteInputTokens,
  ).toBe("unavailable");
  expect(result.measurements.usage.usage?.inputTokens).toBe(40);
  expect(result.measurements.usage.usage?.cacheReadInputTokens).toBe(12);
  const offlineInput = result.runs.reduce(
    (sum, run) =>
      sum + (run.inspection.providerMeasurements.usage.usage?.inputTokens ?? 0),
    0,
  );
  expect(result.measurements.usage.usage?.inputTokens).toBe(offlineInput);
});

test("Agent retains foreground identity after a separately closed summary and session load", async () => {
  const { createTestAgent, userSubmission } =
    await import("../../__tests__/testHelpers.js");
  const { JsonlTraceJournal, RunTraceRecorder } =
    await import("../../trace/index.js");
  const closed: string[] = [];
  const agent = createTestAgent(
    {
      name: "fixture",
      getCapabilities: () => ({ contextWindowTokens: 128000 }),
      async *streamChat() {
        yield { delta: "fixture response" };
      },
    },
    {
      createTraceRun: (identity) => {
        const journal = new JsonlTraceJournal(
          path.join(root, identity.sessionId, `${identity.runId}.jsonl`),
        );
        return {
          recorder: new RunTraceRecorder(identity, journal),
          close: () => {
            journal.close();
            closed.push(identity.runId);
          },
        };
      },
    },
  );
  const summaryControl = agent as unknown as {
    summaryPolicy: {
      rawRecentTurns: number;
      refreshIntervalTurns: number;
      summaryTargetTokens: number;
      contextPressureThreshold: number;
    };
    runSummaryRefresh(reason: "turn_cadence"): Promise<void>;
  };
  summaryControl.summaryPolicy = {
    rawRecentTurns: 0,
    refreshIntervalTurns: 999,
    summaryTargetTokens: 256,
    contextPressureThreshold: 2,
  };
  await agent.streamChat(userSubmission("First"), () => {});
  await agent.streamChat(userSubmission("Second"), () => {});
  const foreground = agent.getSessionTraceIdentity();
  await summaryControl.runSummaryRefresh("turn_cadence");
  expect(agent.getSessionTraceIdentity()).toEqual(foreground);
  expect(closed.at(-1)).not.toBe(foreground.runId);
  agent.importSession(agent.exportSession());
  expect(agent.getSessionTraceIdentity()).toEqual(foreground);
  const legacy = JSON.parse(agent.exportSession());
  delete legacy.metadata.latestForegroundRunId;
  agent.importSession(JSON.stringify(legacy));
  expect(agent.getSessionTraceIdentity().runId).toBeUndefined();
  expect(sessionInspectionLines(root, foreground, "/trace")[0]).toContain(
    foreground.runId,
  );
});
