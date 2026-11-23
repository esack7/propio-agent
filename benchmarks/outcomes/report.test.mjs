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
