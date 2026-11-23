import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareReports, runReport, summarize } from "./report.mjs";

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
