import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTraceCommand } from "../traceCommand.js";
import {
  JsonlTraceJournal,
  exportTraceReadResult,
  type TraceEventEnvelope,
} from "../../trace/index.js";
import { readDiscoveredTrace, selectTraceRun } from "../traceDiscovery.js";
import { getDisplayWidth } from "../../ui/displayWidth.js";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "trace-cli-"));
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function event(
  sequence: number,
  type: string,
  extra: Partial<TraceEventEnvelope> = {},
): TraceEventEnvelope {
  return {
    version: 1,
    eventId: `event-${sequence}`,
    sequence,
    observedAt: "2026-11-14T10:00:00.000Z",
    monotonicNanoseconds: String(sequence * 1_000_000),
    component: "agent",
    type,
    identity: { sessionId: "session", runId: "run", operationId: "turn" },
    payload: {},
    ...extra,
  };
}
function write(
  events: unknown[],
  session = "session",
  run = "run",
  suffix = "",
): string {
  const file = path.join(directory, "traces", session, `${run}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    events.map((e) => JSON.stringify(e) + "\n").join("") + suffix,
  );
  return file;
}
function call(args: string[], width = 100) {
  let stdout = "",
    stderr = "";
  const exit = runTraceCommand(args, {
    sessionsDir: directory,
    width,
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { exit, stdout, stderr };
}
function json(args: string[]) {
  const result = call([...args, "--json"]);
  expect(result.stderr).toBe("");
  expect(result.exit).toBe(0);
  return JSON.parse(result.stdout);
}
function provider(
  sequence: number,
  type: string,
  fields: Record<string, unknown> = {},
) {
  return event(sequence, type, {
    component: "provider",
    identity: {
      sessionId: "session",
      runId: "run",
      requestId: "request",
      attemptId: "attempt",
      operationId: "request-operation",
      parentOperationId: "turn",
    },
    payload: {
      version: 1,
      type,
      provider: "fixture",
      requestedModel: "model",
      trace: { requestId: "request", purpose: "answer" },
      attemptId: "attempt",
      attemptNumber: 1,
      ...fields,
    },
  });
}

it("lists an absent root without creating runtime state", () => {
  expect(json(["list"])).toEqual({
    version: 1,
    command: "list",
    runs: [],
    total: 0,
    omitted: 0,
    inspectionScope: "listed_runs",
    complete: true,
    warnings: [],
  });
  expect(fs.readdirSync(directory)).toEqual([]);
});

it.each(["completed", "failed", "cancelled", "incomplete"])(
  "shows a deterministic %s timeline",
  (outcome) => {
    const events = [
      event(1, "turn_started"),
      provider(2, "provider_attempt_started"),
      provider(3, "provider_usage_reported", {
        availability: "reported",
        usage: { inputTokens: 10, outputTokens: 2 },
        providerReportedCost: { amount: 0.2, currency: "USD" },
      }),
      provider(4, "provider_attempt_completed"),
      event(5, "tool_policy_decision", {
        component: "policy",
        identity: {
          sessionId: "session",
          runId: "run",
          operationId: "tool",
          parentOperationId: "turn",
          toolCallId: "call",
          policyRevisionId: "policy-1",
        },
        payload: {
          toolName: "bash",
          decision: "denied",
          actor: "user",
          reason: "unsafe\x1b[2J\u202e",
        },
      }),
    ];
    if (outcome !== "incomplete") events.push(event(6, `turn_${outcome}`));
    // File order deliberately differs: the envelope sequence owns timeline order.
    write([events[1], events[0], ...events.slice(2)]);
    const result = call(["show", "run"]);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(/[\x1b\u202e]/u);
    expect(result.stdout).toMatchSnapshot();
    const data = json(["show", "run"]);
    expect(data.run.complete).toBe(outcome !== "incomplete");
    expect(data.timeline[0]).toMatchObject({ sequence: 1, relativeMs: 0 });
    expect(data.inspection.providerMeasurements.usage.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
    });
    expect(data.inspection.providerMeasurements.cost.currencies).toEqual([
      { currency: "USD", providerReportedAmount: 0.2 },
    ]);
  },
);

it("does not expose private payloads or read material during show", () => {
  write([
    event(1, "turn_started", {
      payload: {
        prompt: "private prompt",
        response: "private response",
        responseMaterial: { path: "/unreadable/material" },
      },
    }),
    event(2, "turn_completed"),
  ]);
  const result = json(["show", "run"]);
  expect(JSON.stringify(result)).not.toContain("private prompt");
  expect(JSON.stringify(result)).not.toContain("private response");
  expect(result.timeline[1].durationMs).toBe(1);
});

it("reports corrupt records, identity mismatches and a partial final line", () => {
  write(
    [
      event(1, "turn_started"),
      null,
      { hello: "world" },
      event(2, "turn_completed", {
        identity: { sessionId: "other", runId: "run" },
      }),
    ],
    "session",
    "run",
    '{"unfinished":',
  );
  const shown = json(["show", "run"]);
  expect(shown.run.complete).toBe(false);
  expect(shown.run.warnings).toEqual(
    expect.arrayContaining([
      "truncated_final_line at line 5",
      "Invalid event envelope or provider metadata; record omitted",
      "Event identity does not match the journal location; record omitted",
    ]),
  );
  expect(shown.inspection.captureComplete).toBe(false);
  expect(shown.timeline).toHaveLength(1);
  expect(json(["list"]).complete).toBe(false);
  const destination = path.join(directory, "bad-export");
  expect(call(["export", "run", "--output", destination]).exit).toBe(1);
  expect(fs.existsSync(destination)).toBe(false);
});

it("reports empty and gapped journals as incomplete and missing timing as unknown", () => {
  write([]);
  expect(json(["show", "run"]).run.complete).toBe(false);
  write([
    event(2, "turn_started", { monotonicNanoseconds: "", observedAt: "" }),
    event(4, "turn_completed", { monotonicNanoseconds: "invalid" }),
  ]);
  const result = json(["show", "run"]);
  expect(result.run.observedAt).toBeNull();
  expect(result.run.complete).toBe(false);
  expect(
    result.timeline.map((e: { relativeMs: number | null }) => e.relativeMs),
  ).toEqual([null, null]);
  expect(call(["show", "run"]).stdout).toContain("input=unknown");
});

it("rejects malformed provider metadata without crashing measurement aggregation", () => {
  write([
    event(1, "turn_started"),
    provider(2, "provider_usage_reported", {
      providerReportedCost: { amount: 2, currency: {} },
    }),
    event(3, "turn_completed"),
  ]);
  expect(json(["show", "run"]).run.complete).toBe(false);
});

it("selects exact IDs and requires session disambiguation", () => {
  write([event(1, "turn_started"), event(2, "turn_completed")]);
  write(
    [
      event(1, "turn_started", {
        identity: { sessionId: "second", runId: "run", operationId: "turn" },
      }),
    ],
    "second",
  );
  expect(call(["show", "ru"]).stderr).toContain("not found");
  expect(call(["show", "run"]).stderr).toContain("Ambiguous");
  expect(json(["show", "run", "--session", "session"]).run.complete).toBe(true);
  expect(json(["list", "--session", "second"]).runs).toHaveLength(1);
});

it.each(["../run", "/tmp/run", "a/b", "a\\b", "..", "a\x1b[2J"])(
  "rejects unsafe run/session IDs %j",
  (id) => {
    expect(call(["show", id]).exit).toBe(1);
    expect(call(["list", "--session", id]).exit).toBe(1);
    expect(call(["show", id]).stderr).not.toContain("\x1b");
  },
);

it.each([[], ["--help"], ["help"]])("shows offline help %j", (...args) => {
  expect(call(args).stdout).toContain("propio trace show");
});
it.each([
  ["list", "--limit", "0"],
  ["list", "--limit", "1001"],
  ["list", "--limit", "1.2"],
  ["list", "--limit", "-1"],
  ["list", "--limit", "1e2"],
  ["list", "--limit"],
  ["show"],
  ["show", "a", "b"],
  ["show", "run", "--full"],
  ["verify", "bundle", "--session", "s"],
  ["export", "run"],
  ["list", "run"],
  ["list", "--json", "--json"],
  ["wat"],
])("rejects invalid arguments %j", (...args) => {
  const result = call(args);
  expect(result.exit).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toBe("");
});

it("orders newest first with stable ties, a default limit and explicit omissions", () => {
  for (let i = 0; i < 22; i++) {
    const runId = `run-${String(i).padStart(2, "0")}`;
    write(
      [
        event(1, "turn_started", {
          identity: { sessionId: "session", runId, operationId: "turn" },
          observedAt:
            i === 21 ? "2026-11-15T10:00:00Z" : "2026-11-14T10:00:00Z",
        }),
      ],
      "session",
      runId,
    );
  }
  const result = json(["list"]);
  expect(result.runs).toHaveLength(20);
  expect(result.total).toBe(22);
  expect(result.omitted).toBe(2);
  expect(
    result.runs.slice(0, 3).map((r: { runId: string }) => r.runId),
  ).toEqual(["run-21", "run-00", "run-01"]);
  expect(json(["list", "--limit", "1"]).runs).toHaveLength(1);
});

it.each(["journal", "session", "root"])(
  "rejects %s symlinks escaping the trace root",
  (kind) => {
    const external = path.join(directory, "external");
    fs.mkdirSync(external);
    const journal = write([event(1, "turn_started")]);
    if (kind === "journal") {
      fs.renameSync(journal, path.join(external, "run.jsonl"));
      fs.symlinkSync(path.join(external, "run.jsonl"), journal);
    }
    if (kind === "session") {
      fs.rmSync(path.dirname(journal), { recursive: true });
      fs.symlinkSync(external, path.dirname(journal));
    }
    if (kind === "root") {
      fs.rmSync(path.join(directory, "traces"), { recursive: true });
      fs.symlinkSync(external, path.join(directory, "traces"));
    }
    expect(call(["show", "run"]).exit).toBe(1);
    const listed = call(["list", "--json"]);
    if (kind !== "root") {
      expect(JSON.parse(listed.stdout).complete).toBe(false);
      expect(JSON.parse(listed.stdout).runs).toEqual([]);
    } else expect(listed.exit).toBe(1);
  },
);

it("exports standard metadata by default, full material explicitly, and detects tampering", () => {
  const journalPath = write([]);
  const journal = new JsonlTraceJournal(journalPath, { captureLevel: "full" });
  const material = journal.captureMaterial({
    text: "private captured response",
  });
  expect(material).toBeDefined();
  journal.record(event(1, "turn_started"));
  journal.record(
    event(2, "provider_response_captured", {
      payload: { responseMaterial: material },
    }),
  );
  journal.record(event(3, "turn_completed"));
  journal.close();
  const standard = path.join(directory, "standard"),
    full = path.join(directory, "full");
  const result = json(["export", "run", "--output", standard]);
  expect(result.manifest.captureLevel).toBe("standard");
  expect(fs.existsSync(path.join(standard, material!.path))).toBe(false);
  expect(json(["verify", standard]).valid).toBe(true);
  expect(
    json(["export", "run", "--output", full, "--full"]).manifest.captureLevel,
  ).toBe("full");
  expect(fs.readFileSync(path.join(full, material!.path), "utf8")).toContain(
    "private captured response",
  );
  expect(json(["verify", full]).valid).toBe(true);
  fs.appendFileSync(path.join(standard, "events.jsonl"), "tamper");
  const invalid = call(["verify", standard, "--json"]);
  expect(invalid.exit).toBe(1);
  expect(JSON.parse(invalid.stdout).valid).toBe(false);
  expect(JSON.parse(invalid.stdout).findings.length).toBeGreaterThan(0);
});

it("never reuses an existing export destination, including empty directories and symlinks", () => {
  write([event(1, "turn_started"), event(2, "turn_completed")]);
  const destination = path.join(directory, "destination");
  fs.mkdirSync(destination);
  expect(call(["export", "run", "--output", destination]).exit).toBe(1);
  expect(fs.readdirSync(destination)).toEqual([]);
  const link = path.join(directory, "linked");
  fs.symlinkSync(destination, link);
  expect(call(["export", "run", "--output", link]).exit).toBe(1);
  expect(fs.readdirSync(destination)).toEqual([]);
});

it("wraps hostile and wide text at narrow and wide terminal widths", () => {
  write([
    event(1, "turn_started", {
      payload: { reason: "界".repeat(100) + "\n\x1b[2J" },
    }),
    event(2, "turn_failed"),
  ]);
  for (const width of [40, 120]) {
    const result = call(["show", "run"], width);
    expect(result.stdout).not.toContain("\x1b");
    for (const line of result.stdout.trimEnd().split("\n"))
      expect(getDisplayWidth(line)).toBeLessThanOrEqual(width);
  }
});

it("preserves retry relationships and partial usage instead of assuming a failed attempt was free", () => {
  const retry = (
    sequence: number,
    type: string,
    fields: Record<string, unknown> = {},
  ) => {
    const value = provider(sequence, type, {
      attemptId: "retry",
      attemptNumber: 2,
      ...fields,
    });
    return { ...value, identity: { ...value.identity, attemptId: "retry" } };
  };
  write([
    event(1, "turn_started"),
    provider(2, "provider_attempt_started"),
    provider(3, "provider_attempt_failed"),
    provider(4, "provider_retry_wait", { delayMs: 100 }),
    retry(5, "provider_attempt_started"),
    retry(6, "provider_usage_reported", {
      availability: "reported",
      usage: { inputTokens: 20, outputTokens: 3 },
    }),
    retry(7, "provider_attempt_completed"),
    event(8, "turn_completed"),
  ]);
  const result = json(["show", "run"]);
  expect(result.inspection.providerMeasurements.attemptCount).toBe(2);
  expect(result.inspection.providerMeasurements.retries.attemptCount).toBe(1);
  expect(result.inspection.providerMeasurements.usage.completeness).toBe(
    "partial",
  );
  expect(
    result.inspection.providerMeasurements.cost.unpricedAttempts,
  ).toHaveLength(2);
  expect(result.timeline[3]).toMatchObject({
    type: "provider_retry_wait",
    metadata: { delayMs: 100 },
  });
  expect(result.timeline[6]).toMatchObject({
    identity: { requestId: "request", attemptId: "retry" },
    durationMs: 2,
  });
});

it("reports unreadable journals without silently treating the list as complete", () => {
  const file = write([event(1, "turn_started")]);
  fs.chmodSync(file, 0);
  try {
    const result = json(["list"]);
    expect(result.complete).toBe(false);
    expect(result.warnings).toContain("Cannot read journal: session/run");
    expect(call(["show", "run"]).exit).toBe(1);
  } finally {
    fs.chmodSync(file, 0o600);
  }
});

it("exports and verifies an interrupted JSONL with explicit source warnings", () => {
  write([event(1, "turn_started")], "session", "run", "{partial");
  const destination = path.join(directory, "partial");
  const result = json(["export", "run", "--output", destination]);
  expect(result.manifest.captureComplete).toBe(false);
  expect(result.warnings).toContain("truncated_final_line at line 2");
  expect(json(["verify", destination]).valid).toBe(true);
});

it("selects and exports despite unrelated discovery warnings", () => {
  write([event(1, "turn_started"), event(2, "turn_completed")]);
  fs.writeFileSync(
    path.join(directory, "traces", ".DS_Store"),
    "Finder metadata",
  );
  fs.mkdirSync(path.join(directory, "traces", "other"));
  fs.writeFileSync(
    path.join(directory, "traces", "other", "bad..id.jsonl"),
    "invalid",
  );
  expect(json(["show", "run"]).run.complete).toBe(true);
  expect(
    json(["export", "run", "--output", path.join(directory, "bundle")]).manifest
      .runId,
  ).toBe("run");
  expect(json(["list"]).complete).toBe(false);
});

it.each(["append", "replace", "symlink"])(
  "exports the validated snapshot after journal %s",
  (mutation) => {
    const file = write([event(1, "turn_started"), event(2, "turn_completed")]);
    const run = selectTraceRun(path.join(directory, "traces"), "run");
    const snapshot = readDiscoveredTrace(run);
    expect(snapshot.omittedRecordCount).toBe(0);
    const bad =
      JSON.stringify(
        event(3, "turn_started", {
          identity: { sessionId: "outside", runId: "outside" },
        }),
      ) + "\n";
    if (mutation === "append") fs.appendFileSync(file, bad);
    if (mutation === "replace") fs.writeFileSync(file, bad);
    if (mutation === "symlink") {
      const outside = path.join(directory, "outside.jsonl");
      fs.writeFileSync(outside, bad);
      fs.unlinkSync(file);
      fs.symlinkSync(outside, file);
    }
    const destination = path.join(directory, "bundle");
    exportTraceReadResult(
      { events: snapshot.events, warnings: snapshot.readWarnings },
      file,
      destination,
    );
    expect(
      fs.readFileSync(path.join(destination, "events.jsonl"), "utf8"),
    ).not.toContain("outside");
    expect(json(["verify", destination]).valid).toBe(true);
    if (mutation === "symlink")
      expect(() => readDiscoveredTrace(run)).toThrow();
  },
);

it("tracks invalid records with a typed omission count", () => {
  write([event(1, "turn_started"), null, event(2, "turn_completed")]);
  const run = selectTraceRun(path.join(directory, "traces"), "run");
  expect(readDiscoveredTrace(run).omittedRecordCount).toBe(1);
});

it("keeps help readable for unknown commands and every subcommand", () => {
  for (const command of ["list", "show", "export", "verify"]) {
    const result = call([command, "--help"]);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("\n  propio trace show");
  }
  const unknown = call(["unknown"]);
  expect(unknown.exit).toBe(1);
  expect(unknown.stderr).not.toContain("\\n");
  expect(unknown.stderr).toContain("propio trace --help");
});

it("preserves whole UUIDs and destination paths when stdout has no terminal width", () => {
  const id = "abc12345-abcd-4567-8901-234567890123";
  write([
    event(1, "turn_started", {
      identity: {
        sessionId: "session",
        runId: "run",
        operationId: id,
        requestId: id,
        parentOperationId: id,
        attemptId: id,
      },
    }),
    event(2, "turn_completed"),
  ]);
  let output = "";
  expect(
    runTraceCommand(["show", "run"], {
      sessionsDir: directory,
      stdout: (text) => {
        output += text;
      },
      stderr: () => {},
    }),
  ).toBe(0);
  expect(
    output
      .split("\n")
      .some(
        (line) =>
          line.includes(`requestId=${id}`) && line.includes(`attemptId=${id}`),
      ),
  ).toBe(true);
  expect(output.split("\n").some((line) => line.length > 100)).toBe(true);
});

it("renders a single duration for terminal provider events", () => {
  write([
    event(1, "turn_started"),
    provider(2, "provider_attempt_started"),
    provider(3, "provider_attempt_completed", { durationMs: 999 }),
    event(4, "turn_completed"),
  ]);
  const result = call(["show", "run"]);
  expect(result.stdout).toContain("duration=1ms");
  expect(result.stdout).not.toContain("durationMs=");
});

it("inspects only selected journals and reconciles counts including unreadable runs", () => {
  write([event(1, "turn_started"), event(2, "turn_completed")]);
  const old = event(1, "turn_started", {
    observedAt: "2025-01-01T00:00:00Z",
    identity: { sessionId: "session", runId: "old", operationId: "turn" },
  });
  write([old], "session", "old", "null\n".repeat(100000));
  const unreadable = write([], "session", "unreadable");
  fs.chmodSync(unreadable, 0);
  try {
    const result = json(["list", "--limit", "1"]);
    expect(result.runs.map((run: { runId: string }) => run.runId)).toEqual([
      "run",
    ]);
    expect(result.total).toBe(3);
    expect(result.omitted).toBe(2);
    expect(result.total).toBe(result.runs.length + result.omitted);
    expect(result.inspectionScope).toBe("listed_runs");
    expect(result.complete).toBe(false);
    expect(
      result.warnings.some((warning: string) =>
        warning.includes("record omitted"),
      ),
    ).toBe(false);
  } finally {
    fs.chmodSync(unreadable, 0o600);
  }
});
