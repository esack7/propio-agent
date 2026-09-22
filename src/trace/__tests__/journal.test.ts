import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  JsonlTraceJournal,
  readTraceJournal,
  RunTraceRecorder,
  exportTraceJournal,
  inspectTraceExport,
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
        homePath: "/home/example/private/config.json",
        endpointPath: "/v1/messages",
        customPath: "/custom/checkouts/private.json",
        pathMessage:
          "(/Users/me/a.ts) /opt/app/secret.json /srv/data/cfg.yml /root/.ssh/id_rsa /etc/passwd D:\\work\\checkout\\file.ts \\\\server\\share\\private.txt",
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
    expect(persisted).not.toContain("/home/example/private/config.json");
    expect(persisted).not.toContain("/custom/checkouts/private.json");
    expect(persisted).not.toContain("/opt/app/secret.json");
    expect(persisted).not.toContain("/srv/data/cfg.yml");
    expect(persisted).not.toContain("/root/.ssh/id_rsa");
    expect(persisted).not.toContain("/etc/passwd");
    expect(persisted).not.toContain("D:\\work\\checkout\\file.ts");
    expect(persisted).not.toContain("\\\\server\\share\\private.txt");
    expect(persisted).toContain("([REDACTED])");
    expect(persisted).toContain("/v1/messages");
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
    expect(manifest.version).toBe(3);
    expect(manifest.files[0].path).toBe("events.jsonl");
    expect(verifyTraceExport(exportDirectory)).toEqual([]);
    const { providerMeasurements: _measurements, ...legacyManifest } = manifest;
    fs.rmSync(path.join(exportDirectory, "manifest.sha256"));
    fs.writeFileSync(
      path.join(exportDirectory, "manifest.json"),
      JSON.stringify({ ...legacyManifest, version: 2 }),
    );
    expect(verifyTraceExport(exportDirectory)).toEqual([
      "Missing provider measurements in version 2 manifest",
    ]);
    fs.writeFileSync(
      path.join(exportDirectory, "manifest.json"),
      JSON.stringify({ ...legacyManifest, version: 1 }),
    );
    expect(verifyTraceExport(exportDirectory)).toEqual([]);
    fs.appendFileSync(path.join(exportDirectory, "events.jsonl"), "tampered");
    expect(verifyTraceExport(exportDirectory)).toEqual([
      "Size mismatch: events.jsonl",
      "Hash mismatch: events.jsonl",
    ]);
  });

  it("exports an interrupted run for offline inspection without raw artifacts or source paths", () => {
    const sourceDirectory = path.join(tempDir, "original-home");
    fs.mkdirSync(sourceDirectory);
    const journalPath = path.join(sourceDirectory, "run.jsonl");
    const journal = new JsonlTraceJournal(journalPath, { redact: false });
    const recorder = new RunTraceRecorder(
      {
        sessionId: "session-1",
        runId: "interrupted-run",
        configurationRevisionId: "config-1",
      },
      journal,
    );
    recorder.record({
      component: "cli",
      type: "run_started",
      payload: {
        configuration: {
          packages: { agent: "1.1.4", providers: "0.4.0" },
          apiKey: "synthetic-secret-value",
          note: `${sourceDirectory}/private-config.json`,
        },
      },
    });
    recorder.record({
      component: "context",
      type: "prompt_plan_selected",
      identity: { promptRevisionId: "prompt-1" },
      payload: {
        includedArtifactIds: ["artifact-1"],
        omissions: [
          {
            kind: "artifact",
            id: "artifact-pruned",
            reason: "previously evicted",
            reasonCode: "artifact_pruned",
          },
          { kind: "artifact", id: "artifact-budget", reason: "context_budget" },
        ],
      },
    });
    recorder.record({
      component: "agent",
      type: "provider_request_dispatched",
      identity: { operationId: "provider-1" },
      payload: { messageCount: 1 },
    });
    recorder.record({
      component: "agent",
      type: "provider_request_completed",
      identity: { operationId: "provider-1" },
      payload: {},
    });
    recorder.record({
      component: "tool",
      type: "tool_execution_completed",
      identity: { operationId: "tool-1" },
      payload: { status: "success" },
    });
    journal.close();
    fs.appendFileSync(journalPath, '{"version":"synthetic-secret-value');

    const staging = path.join(tempDir, "staging");
    const manifest = exportTraceJournal(journalPath, staging);
    expect(manifest.captureComplete).toBe(false);
    expect(manifest.warnings).toEqual([
      expect.objectContaining({ type: "truncated_final_line" }),
    ]);
    expect(manifest.revisions).toMatchObject({
      configurationIds: ["config-1"],
      promptIds: ["prompt-1"],
      packages: { agent: "1.1.4", providers: "0.4.0" },
    });
    expect(manifest.material).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "journal", status: "partial" }),
        expect.objectContaining({ kind: "tool_result", status: "omitted" }),
        expect.objectContaining({ kind: "prompt_artifact", status: "omitted" }),
        expect.objectContaining({ kind: "prompt_artifact", status: "pruned" }),
        expect.objectContaining({
          kind: "provider_payload",
          status: "omitted",
        }),
        expect.objectContaining({
          kind: "workspace_baseline",
          status: "missing",
        }),
        expect.objectContaining({ kind: "workspace_diff", status: "missing" }),
      ]),
    );

    const bundle = path.join(tempDir, "fresh-directory");
    fs.renameSync(staging, bundle);
    fs.rmSync(sourceDirectory, { recursive: true });
    expect(verifyTraceExport(bundle)).toEqual([]);
    const exportedText = fs.readFileSync(
      path.join(bundle, "events.jsonl"),
      "utf8",
    );
    const manifestText = fs.readFileSync(
      path.join(bundle, "manifest.json"),
      "utf8",
    );
    expect(`${exportedText}${manifestText}`).not.toContain(
      "synthetic-secret-value",
    );
    expect(`${exportedText}${manifestText}`).not.toContain(sourceDirectory);
    expect(
      inspectTraceJournal(path.join(bundle, "events.jsonl")),
    ).toMatchObject({
      eventCount: 5,
      captureComplete: true,
      operations: [expect.objectContaining({ outcome: "completed" })],
    });
    expect(inspectTraceExport(bundle)).toMatchObject({
      eventCount: 5,
      captureComplete: false,
      warnings: [expect.objectContaining({ type: "truncated_final_line" })],
      manifest: { version: 3, captureComplete: false },
    });
  });

  it("rejects an export file redirected outside the bundle", () => {
    const journalPath = path.join(tempDir, "source.jsonl");
    const journal = new JsonlTraceJournal(journalPath);
    const recorder = new RunTraceRecorder(
      { sessionId: "session-1", runId: "run-1" },
      journal,
    );
    recorder.record({ component: "cli", type: "run_started", payload: {} });
    journal.close();
    const bundle = path.join(tempDir, "bundle");
    exportTraceJournal(journalPath, bundle);
    fs.rmSync(path.join(bundle, "events.jsonl"));
    fs.symlinkSync(journalPath, path.join(bundle, "events.jsonl"));
    expect(verifyTraceExport(bundle)).toEqual([
      "Unsafe export path: events.jsonl",
    ]);
    fs.rmSync(path.join(bundle, "manifest.json"));
    fs.symlinkSync(journalPath, path.join(bundle, "manifest.json"));
    expect(verifyTraceExport(bundle)).toEqual(["Unsafe manifest path"]);
  });

  it("detects changed manifest claims even when its checksum is rewritten", () => {
    const journalPath = path.join(tempDir, "source.jsonl");
    const journal = new JsonlTraceJournal(journalPath);
    const recorder = new RunTraceRecorder(
      {
        sessionId: "session-1",
        runId: "run-1",
        configurationRevisionId: "config-1",
      },
      journal,
    );
    recorder.record({
      component: "cli",
      type: "run_started",
      payload: { configuration: { packages: { agent: "1.1.4" } } },
    });
    recorder.record({
      component: "agent",
      type: "provider_request_dispatched",
      identity: { operationId: "request-1" },
      payload: {},
    });
    recorder.record({
      component: "tool",
      type: "tool_execution_completed",
      identity: { operationId: "tool-1" },
      payload: { status: "success" },
    });
    journal.close();
    const bundle = path.join(tempDir, "bundle");
    exportTraceJournal(journalPath, bundle);
    expect(verifyTraceExport(bundle)).toEqual([]);

    const manifestPath = path.join(bundle, "manifest.json");
    const checksumPath = path.join(bundle, "manifest.sha256");
    const original = fs.readFileSync(manifestPath);
    const cases: ReadonlyArray<{
      field: string;
      change: (manifest: Record<string, unknown>) => void;
    }> = [
      {
        field: "eventCount",
        change: (manifest) => {
          manifest.eventCount = 999;
        },
      },
      {
        field: "captureComplete",
        change: (manifest) => {
          manifest.captureComplete = true;
        },
      },
      {
        field: "operations",
        change: (manifest) => {
          manifest.operations = [];
        },
      },
      {
        field: "material",
        change: (manifest) => {
          manifest.material = [];
        },
      },
      {
        field: "revisions",
        change: (manifest) => {
          manifest.revisions = {
            ...(manifest.revisions as object),
            packages: { agent: "9.9.9" },
          };
        },
      },
    ];
    for (const testCase of cases) {
      const modified = JSON.parse(original.toString("utf8")) as Record<
        string,
        unknown
      >;
      testCase.change(modified);
      const bytes = Buffer.from(`${JSON.stringify(modified, null, 2)}\n`);
      fs.writeFileSync(manifestPath, bytes);
      expect(verifyTraceExport(bundle)).toContain("Manifest checksum mismatch");
      fs.writeFileSync(
        checksumPath,
        `${createHash("sha256").update(bytes).digest("hex")}\n`,
      );
      expect(verifyTraceExport(bundle)).toContain(
        `Manifest ${testCase.field} mismatch`,
      );
      fs.writeFileSync(
        checksumPath,
        `${createHash("sha256").update(original).digest("hex")}\n`,
      );
    }
    fs.writeFileSync(manifestPath, original);
    fs.rmSync(checksumPath);
    expect(verifyTraceExport(bundle)).toContain("Missing manifest checksum");
  });

  it("returns failures instead of throwing for malformed manifest entries", () => {
    const journalPath = path.join(tempDir, "source.jsonl");
    const journal = new JsonlTraceJournal(journalPath);
    new RunTraceRecorder(
      { sessionId: "session-1", runId: "run-1" },
      journal,
    ).record({ component: "cli", type: "run_started", payload: {} });
    journal.close();
    const bundle = path.join(tempDir, "bundle");
    exportTraceJournal(journalPath, bundle);
    const manifestPath = path.join(bundle, "manifest.json");
    const checksumPath = path.join(bundle, "manifest.sha256");
    const original = fs.readFileSync(manifestPath, "utf8");

    for (const [field, expectedFailure] of [
      ["material", "Invalid material entry"],
      ["files", "Invalid export file entry"],
    ] as const) {
      const altered = JSON.parse(original) as Record<string, unknown>;
      altered[field] = [null];
      const bytes = Buffer.from(`${JSON.stringify(altered)}\n`);
      fs.writeFileSync(manifestPath, bytes);
      fs.writeFileSync(
        checksumPath,
        `${createHash("sha256").update(bytes).digest("hex")}\n`,
      );
      expect(() => verifyTraceExport(bundle)).not.toThrow();
      expect(verifyTraceExport(bundle)).toContain(expectedFailure);
      expect(() => inspectTraceExport(bundle)).toThrow(
        "Trace export verification failed",
      );
    }
  });

  it("preserves artifact status changes across prompt plans", () => {
    const journalPath = path.join(tempDir, "source.jsonl");
    const journal = new JsonlTraceJournal(journalPath);
    const recorder = new RunTraceRecorder(
      { sessionId: "session-1", runId: "run-1" },
      journal,
    );
    recorder.record({
      component: "context",
      type: "prompt_plan_selected",
      payload: { includedArtifactIds: ["included-then-pruned"] },
    });
    recorder.record({
      component: "context",
      type: "prompt_plan_selected",
      payload: {
        omissions: [
          {
            kind: "artifact",
            id: "included-then-pruned",
            reason: "evicted",
            reasonCode: "artifact_pruned",
          },
          {
            kind: "artifact",
            id: "pruned-then-included",
            reason: "evicted",
            reasonCode: "artifact_pruned",
          },
        ],
      },
    });
    recorder.record({
      component: "context",
      type: "prompt_plan_selected",
      payload: { includedArtifactIds: ["pruned-then-included"] },
    });
    journal.close();

    const manifest = exportTraceJournal(
      journalPath,
      path.join(tempDir, "bundle"),
    );
    const statuses = (id: string) =>
      manifest.material
        .filter((item) => item.referenceId === id)
        .map((item) => item.status);
    expect(statuses("included-then-pruned")).toEqual(["omitted", "pruned"]);
    expect(statuses("pruned-then-included")).toEqual(["pruned", "omitted"]);
    expect(verifyTraceExport(path.join(tempDir, "bundle"))).toEqual([]);
  });
});
