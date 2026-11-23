import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  inspectSessionUsage,
  sessionInspectionLines,
} from "../sessionInspection.js";
import { getSlashCommandCompletionCommands } from "../../ui/slashCommands.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "session-inspection-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

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
  expect(usage.measurements.usage.usage).toBeUndefined();
  expect(
    sessionInspectionLines(root, { sessionId: "current" }, "/usage").join("\n"),
  ).not.toMatch(/Cost:|estimated=/);
});

test("foreground, summary and retry measurements reconcile with offline snapshots", () => {
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
  const result = inspectSessionUsage(root, "session");
  expect(result.measurements.requestCount).toBe(2);
  expect(result.measurements.attemptCount).toBe(4);
  expect(result.measurements.usage.usage?.inputTokens).toBe(40);
  expect(result.measurements.usage.usage?.cacheReadInputTokens).toBe(12);
  const offlineInput = result.runs.reduce(
    (sum, run) =>
      sum + (run.inspection.providerMeasurements.usage.usage?.inputTokens ?? 0),
    0,
  );
  expect(result.measurements.usage.usage?.inputTokens).toBe(offlineInput);
  expect(result.runs[0].events[0].observedAt).toBe("2026-11-15T00:00:00.000Z");
  expect(
    sessionInspectionLines(
      root,
      { sessionId: "session", runId: "foreground" },
      "/trace",
    )[0],
  ).toContain("foreground");
});
