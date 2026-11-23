import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  observeTrial,
  compareReports,
  runCommand,
  runReport,
  summarize,
} from "./report.mjs";

test("repeated scripted trials retain trace observation and unknown usage", async () => {
  const report = await runReport({ tasks: ["fix-media-type"], repeats: 2 });
  assert.equal(report.summary.overall.scheduled, 2);
  assert.equal(report.summary.overall.passed, 2);
  assert.equal(report.trials.length, 2);
  for (const row of report.trials) {
    assert.ok(row.startedAt <= row.endedAt);
    assert.ok(row.trace.observedAt);
    assert.ok(row.trace.runs.length);
    const run = row.trace.runs[0];
    assert.ok(run.runId);
    assert.ok(run.firstObservedAt);
    assert.ok(run.lastObservedAt);
    assert.notEqual(run.usage.completeness, "complete");
    assert.ok(
      Object.values(run.usage.metricCompleteness).includes("unavailable"),
    );
  }
  const missing = structuredClone(report);
  missing.trials.pop();
  assert.equal(summarize(missing).overall.passRate, 0.5);
  assert.deepEqual(compareReports(report, missing).issues, ["missing trials"]);
  const changed = structuredClone(report);
  changed.taskSetVersion++;
  assert.equal(compareReports(report, changed).compatible, false);
  assert.equal(compareReports(report, report).percentagePoints, 0);
});

test("failed and errored trials remain in denominators and configurations differ", async () => {
  const failed = await runReport({
    tasks: ["extend-locales"],
    repeats: 2,
    scriptedMode: "noop",
  });
  const errored = await runReport({
    tasks: ["extend-locales"],
    repeats: 2,
    cliPath: "/nonexistent/cli.cjs",
  });
  assert.equal(failed.summary.overall.passRate, 0);
  assert.ok(failed.trials.every((row) => row.outcome === "failed"));
  assert.equal(errored.summary.overall.errors, 2);
  assert.ok(errored.trials.every((row) => row.reason));
  const comparison = compareReports(failed, errored);
  assert.equal(comparison.compatible, true);
  assert.notEqual(
    failed.configuration.identity,
    errored.configuration.identity,
  );
  const fewer = structuredClone(failed);
  fewer.schedule.pop();
  assert.ok(
    compareReports(failed, fewer).issues.includes(
      "incompatible trial schedules",
    ),
  );
});

test("documented run and compare commands persist repeated credential-free reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "outcome-report-command-"));
  const execute = promisify(execFile);
  const command = "benchmarks/outcomes/report.mjs";
  const left = join(root, "left.json");
  const right = join(root, "right.json");
  try {
    for (const output of [left, right]) {
      await execute(process.execPath, [command, "run", output, "2"], {
        timeout: 60000,
      });
      const report = JSON.parse(await readFile(output, "utf8"));
      assert.equal(report.summary.overall.scheduled, 8);
      assert.equal(report.summary.overall.passed, 8);
    }
    const { stdout } = await execute(process.execPath, [
      command,
      "compare",
      left,
      right,
    ]);
    const comparison = JSON.parse(stdout);
    assert.equal(comparison.compatible, true);
    assert.equal(comparison.percentagePoints, 0);
    assert.equal(Object.keys(comparison.tasks).length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline mixed outcomes retain scheduled denominators and configuration labels", () => {
  const report = {
    version: 1,
    taskSetVersion: 1,
    tasks: ["fixture"],
    configuration: { label: "mixed", identity: "configuration-a" },
    schedule: [1, 2, 3, 4].map((trial) => ({ task: "fixture", trial })),
    trials: ["passed", "failed", "error"].map((outcome, index) => ({
      task: "fixture",
      trial: index + 1,
      outcome,
    })),
  };
  assert.deepEqual(summarize(report).overall, {
    scheduled: 4,
    passed: 1,
    missing: 1,
    errors: 1,
    passRate: 0.25,
  });
  const comparison = compareReports(report, report);
  assert.equal(comparison.percentagePoints, null);
  assert.deepEqual(comparison.issues, ["missing trials"]);
  assert.equal(comparison.configurations[0].identity, "configuration-a");
});

test("non-object provider configurations are rejected before scheduling", async () => {
  for (const providerConfig of [null, [], "scripted", 1, false]) {
    await assert.rejects(runReport({ providerConfig }), /configuration object/);
  }
  const root = await mkdtemp(join(tmpdir(), "outcome-invalid-config-"));
  try {
    const config = join(root, "provider.json");
    const output = join(root, "report.json");
    await writeFile(config, JSON.stringify({ providers: {} }));
    let started = false;
    await assert.rejects(
      runCommand(["run", output, "1", "--provider-config", config], {
        beforeRun: () => {
          started = true;
        },
      }),
      /provider configuration/,
    );
    assert.equal(started, false);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safety override records a distinct effective configuration", async () => {
  const denied = await runReport({ tasks: [], repeats: 1 });
  const permitted = await runReport({
    tasks: [],
    repeats: 1,
    permitSafetyWrite: true,
  });
  assert.notEqual(
    denied.configuration.identity,
    permitted.configuration.identity,
  );
  assert.equal(denied.configuration.effective.safetyRules, "fixture-v1");
  assert.equal(
    permitted.configuration.effective.safetyRules,
    "fixture-v1-permit-safety-write",
  );
});

test("existing report output prevents trials and preserves its contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "outcome-existing-output-"));
  try {
    const output = join(root, "report.json");
    await writeFile(output, "existing report");
    let started = false;
    await assert.rejects(
      runCommand(["run", output, "1"], {
        beforeRun: () => {
          started = true;
        },
      }),
      { code: "EEXIST" },
    );
    assert.equal(started, false);
    assert.equal(await readFile(output, "utf8"), "existing report");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("partial scripted usage retains measured input without inventing other metrics", async () => {
  const report = await runReport({
    tasks: ["fix-media-type"],
    repeats: 1,
    scriptedMode: "partial-usage",
  });
  assert.equal(report.summary.overall.passed, 1);
  const { usage } = report.trials[0].trace.runs[0];
  assert.equal(usage.usage.inputTokens, 7);
  assert.equal(usage.completeness, "partial");
  assert.equal(usage.metricCompleteness.inputTokens, "partial");
  assert.equal(usage.metricCompleteness.outputTokens, "unavailable");
  assert.equal(usage.usage.outputTokens, undefined);
  for (const [metric, completeness] of Object.entries(
    usage.metricCompleteness,
  )) {
    if (completeness === "unavailable")
      assert.equal(usage.usage[metric], undefined);
  }
});

test("empty and gapped journals cannot claim complete measurements", async () => {
  const home = await mkdtemp(join(tmpdir(), "outcome-trace-"));
  const directory = join(home, ".propio/sessions/workspace/traces/session");
  try {
    await mkdir(directory, { recursive: true });
    assert.equal((await observeTrial(home)).completeness, "unavailable");
    const path = join(directory, "run.jsonl");
    await writeFile(path, "");
    assert.equal((await observeTrial(home)).runs[0].captureComplete, false);
    const event = (sequence, type) => ({
      version: 1,
      eventId: String(sequence),
      sequence,
      observedAt: new Date().toISOString(),
      monotonicNanoseconds: "1",
      component: "agent",
      type,
      identity: {
        sessionId: "session",
        runId: "run",
        operationId: "operation",
      },
      payload: {},
    });
    await writeFile(
      path,
      [event(1, "run_started"), event(3, "run_completed")]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const usage = {
      ...event(4, "provider_usage_reported"),
      component: "provider",
      identity: {
        sessionId: "session",
        runId: "run",
        requestId: "request",
        attemptId: "attempt",
      },
      payload: {
        type: "provider_usage_reported",
        provider: "scripted",
        requestedModel: "requested",
        actualModel: "observed",
        trace: { requestId: "request", purpose: "answer" },
        attemptId: "attempt",
        availability: "partial",
        usage: { inputTokens: 7 },
      },
    };
    await writeFile(path, JSON.stringify(usage) + "\n", { flag: "a" });
    await writeFile(
      path,
      JSON.stringify({
        ...usage,
        sequence: 5,
        eventId: "5",
        type: "provider_response_metadata",
        payload: { ...usage.payload, type: "provider_response_metadata" },
      }) + "\n",
      { flag: "a" },
    );
    const run = (await observeTrial(home)).runs[0];
    assert.equal(run.usage.usage.inputTokens, 7);
    assert.equal(run.usage.metricCompleteness.inputTokens, "partial");
    assert.equal(run.models[0].actualModel, "observed");
    assert.equal(run.models[0].requestedModel, "requested");
    assert.equal(run.captureComplete, false);
    assert.notEqual(run.usage.completeness, "complete");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
