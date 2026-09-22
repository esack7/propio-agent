import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  JsonlTraceJournal,
  readTraceJournal,
  RunTraceRecorder,
  exportTraceJournal,
  inspectTraceJournal,
  verifyTraceExport,
  type TraceCaptureFailure,
} from "../index.js";

describe("JSONL trace journal", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-trace-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes ordered envelopes that parse directly", () => {
    const journalPath = path.join(tempDir, "run.jsonl");
    const journal = new JsonlTraceJournal(journalPath);
    const recorder = new RunTraceRecorder(
      { sessionId: "session-1", runId: "run-1" },
      journal,
    );

    recorder.record({ component: "agent", type: "run_started", payload: {} });
    recorder.record(
      {
        component: "tool",
        type: "tool_completed",
        identity: { operationId: "operation-1" },
        payload: { status: "success" },
      },
      { durable: true },
    );
    journal.close();

    const result = readTraceJournal(journalPath);
    expect(result.warnings).toEqual([]);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(new Set(result.events.map((event) => event.eventId)).size).toBe(2);
    expect(result.events[1].identity).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      operationId: "operation-1",
    });
  });

  it("retains valid records and reports a truncated final line", () => {
    const journalPath = path.join(tempDir, "run.jsonl");
    fs.writeFileSync(
      journalPath,
      `${JSON.stringify({ version: 1, eventId: "one", sequence: 1 })}\n{"version":`,
    );

    const result = readTraceJournal(journalPath);
    expect(result.events).toHaveLength(1);
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: "truncated_final_line", line: 2 }),
    ]);
  });

  it("reports open failure independently instead of throwing", () => {
    const failures: TraceCaptureFailure[] = [];
    const parentFile = path.join(tempDir, "not-a-directory");
    fs.writeFileSync(parentFile, "occupied");

    const journal = new JsonlTraceJournal(path.join(parentFile, "run.jsonl"), {
      onCaptureFailure: (failure) => failures.push(failure),
    });
    expect(journal.captureDegraded).toBe(true);
    expect(failures).toEqual([expect.objectContaining({ operation: "open" })]);
    expect(() =>
      journal.record({
        version: 1,
        eventId: "ignored",
        sequence: 1,
        observedAt: new Date().toISOString(),
        monotonicNanoseconds: "1",
        component: "agent",
        type: "ignored",
        identity: { sessionId: "session", runId: "run" },
        payload: {},
      }),
    ).not.toThrow();
  });

  it("redacts secret keys and token-shaped values in standard capture", () => {
    const journalPath = path.join(tempDir, "redacted.jsonl");
    const journal = new JsonlTraceJournal(journalPath);
    const recorder = new RunTraceRecorder(
      { sessionId: "session-1", runId: "run-1" },
      journal,
    );
    recorder.record({
      component: "provider",
      type: "provider_request_failed",
      payload: {
        apiKey: "synthetic-secret",
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        clientSecret: "client-secret",
        inputTokenCount: 42,
        outputTokenRecoveryLimit: 3,
        tokenEstimate: { input: 40, output: 2 },
        provider: {
          apiKey: { present: true, source: "settings_file" },
        },
        message: "Authorization: Bearer token-value and sk-example123456",
      },
    });
    journal.close();

    const persisted = fs.readFileSync(journalPath, "utf8");
    expect(persisted).not.toContain("synthetic-secret");
    expect(persisted).not.toContain("access-secret");
    expect(persisted).not.toContain("refresh-secret");
    expect(persisted).not.toContain("client-secret");
    expect(persisted).not.toContain("token-value");
    expect(persisted).not.toContain("sk-example123456");
    expect(persisted).toContain("[REDACTED]");
    expect(readTraceJournal(journalPath).events[0].payload).toMatchObject({
      provider: {
        apiKey: { present: true, source: "settings_file" },
      },
      inputTokenCount: 42,
      outputTokenRecoveryLimit: 3,
      tokenEstimate: { input: 40, output: 2 },
    });
  });

  it("does not treat connected provider attempts as completed requests", () => {
    const journalPath = path.join(tempDir, "provider-midstream.jsonl");
    const journal = new JsonlTraceJournal(journalPath);
    const recorder = new RunTraceRecorder(
      { sessionId: "session-1", runId: "run-1" },
      journal,
    );
    const operationId = "provider-operation";
    recorder.record({
      component: "provider",
      type: "provider_request_started",
      identity: { operationId },
      payload: {},
    });
    recorder.record({
      component: "provider",
      type: "provider_attempt_started",
      identity: { operationId, attemptId: "attempt-1" },
      payload: {},
    });
    recorder.record({
      component: "provider",
      type: "provider_attempt_connected",
      identity: { operationId, attemptId: "attempt-1" },
      payload: {},
    });
    journal.close();

    expect(inspectTraceJournal(journalPath)).toMatchObject({
      captureComplete: false,
      operations: [
        {
          operationId,
          component: "provider",
          startedType: "provider_request_started",
          outcome: "unknown",
        },
      ],
    });
  });

  it("inspects, exports, and verifies a run without executing recorded work", () => {
    const journalPath = path.join(tempDir, "source.jsonl");
    const journal = new JsonlTraceJournal(journalPath);
    const recorder = new RunTraceRecorder(
      {
        sessionId: "session-1",
        runId: "run-2",
        previousRunId: "run-1",
      },
      journal,
    );
    recorder.record({
      component: "tool",
      type: "tool_execution_started",
      identity: { operationId: "operation-1" },
      payload: { toolName: "write" },
    });
    recorder.record(
      {
        component: "tool",
        type: "tool_execution_completed",
        identity: { operationId: "operation-1" },
        payload: { status: "success" },
      },
      { durable: true },
    );
    journal.close();

    const inspection = inspectTraceJournal(journalPath);
    expect(inspection).toMatchObject({
      eventCount: 2,
      sessionId: "session-1",
      runId: "run-2",
      previousRunId: "run-1",
      captureComplete: true,
    });
    expect(inspection.operations).toEqual([
      expect.objectContaining({ outcome: "completed" }),
    ]);

    const exportDirectory = path.join(tempDir, "export");
    const manifest = exportTraceJournal(journalPath, exportDirectory);
    expect(manifest.files[0].path).toBe("events.jsonl");
    expect(verifyTraceExport(exportDirectory)).toEqual([]);
    fs.appendFileSync(path.join(exportDirectory, "events.jsonl"), "tampered");
    expect(verifyTraceExport(exportDirectory)).toEqual([
      "Hash mismatch: events.jsonl",
    ]);
  });
});
