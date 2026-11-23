import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTrials } from "./runner.mjs";

const tasks = [
  "fix-media-type",
  "extend-locales",
  "untrusted-content",
  "permission-denial",
];

// Deliberately omit free-form provider fields, endpoints, credentials and prompts.
function configuration(options) {
  const selected = options.providerConfig;
  const settings = selected
    ? {
        default: selected.default,
        providers: selected.providers?.map(
          ({ name, type, defaultModel, models }) => ({
            name,
            type,
            defaultModel,
            models: models?.map(({ key, contextWindowTokens }) => ({
              key,
              contextWindowTokens,
            })),
          }),
        ),
      }
    : {
        provider: "scripted",
        model: "scripted",
        mode: options.scriptedMode ?? "repair",
      };
  const effective = {
    settings,
    permissions: "accept-edits",
    timeoutMs: options.timeoutMs ?? 15000,
    traceCapture: "standard",
    safetyRules: "fixture-v1",
  };
  return {
    label: options.label ?? (selected ? "explicit-provider" : "scripted"),
    identity: createHash("sha256")
      .update(JSON.stringify(effective))
      .digest("hex"),
    effective,
  };
}

async function observeTrial(home) {
  const { inspectTraceJournal } = await import("../../dist/trace/index.js");
  const root = join(home, ".propio/sessions");
  const names = await readdir(root, { recursive: true });
  const runs = [];
  for (const name of names.filter(
    (name) => name.includes("traces/") && name.endsWith(".jsonl"),
  )) {
    const inspection = await inspectTraceJournal(join(root, name));
    const measurements = inspection.providerMeasurements;
    runs.push({
      sessionId: inspection.sessionId,
      runId: inspection.runId,
      firstObservedAt: inspection.firstObservedAt ?? null,
      lastObservedAt: inspection.lastObservedAt ?? null,
      captureComplete: inspection.captureComplete,
      usage: measurements.usage,
      models: measurements.attempts.map(
        ({ requestedModel, actualModel, purpose, requestId, attemptId }) => ({
          requestedModel,
          actualModel,
          purpose,
          requestId,
          attemptId,
        }),
      ),
    });
  }
  return { observedAt: new Date().toISOString(), runs };
}

export function summarize(report) {
  const rows = report.schedule.map(({ task, trial }) =>
    report.trials.find((row) => row.task === task && row.trial === trial),
  );
  const count = (items) => ({
    scheduled: items.length,
    passed: items.filter((row) => row?.outcome === "passed").length,
    missing: items.filter((row) => !row).length,
    errors: items.filter((row) => row?.outcome === "error").length,
    passRate: items.length
      ? items.filter((row) => row?.outcome === "passed").length / items.length
      : null,
  });
  return {
    overall: count(rows),
    tasks: Object.fromEntries(
      report.tasks.map((task) => [
        task,
        count(rows.filter((_, i) => report.schedule[i].task === task)),
      ]),
    ),
  };
}

export async function runReport(options = {}) {
  const repeats = options.repeats ?? 2;
  if (!Number.isSafeInteger(repeats) || repeats < 1)
    throw new Error("repeats must be a positive integer");
  const selectedTasks = options.tasks ?? tasks;
  const report = {
    version: 1,
    taskSetVersion: 1,
    tasks: selectedTasks,
    configuration: configuration(options),
    startedAt: new Date().toISOString(),
    schedule: [],
    trials: [],
  };
  const scheduledTasks = selectedTasks.flatMap((task) =>
    Array(repeats).fill(task),
  );
  report.schedule = scheduledTasks.map((task, index) => ({
    task,
    trial: index + 1,
  }));
  report.trials = await runTrials({
    ...options,
    tasks: scheduledTasks,
    observeTrial,
  });
  report.endedAt = new Date().toISOString();
  report.summary = summarize(report);
  return report;
}

export function compareReports(left, right) {
  const issues = [];
  if (left.version !== 1 || right.version !== 1)
    issues.push("unsupported report version");
  if (
    left.taskSetVersion !== right.taskSetVersion ||
    JSON.stringify(left.tasks) !== JSON.stringify(right.tasks)
  )
    issues.push("incompatible fixtures");
  if (JSON.stringify(left.schedule) !== JSON.stringify(right.schedule))
    issues.push("incompatible trial schedules");
  const a = summarize(left),
    b = summarize(right);
  if (a.overall.missing || b.overall.missing) issues.push("missing trials");
  return {
    compatible: issues.length === 0,
    issues,
    configurations: [left.configuration, right.configuration],
    left: a,
    right: b,
    percentagePoints: issues.length
      ? null
      : 100 * (b.overall.passRate - a.overall.passRate),
    tasks: issues.length
      ? null
      : Object.fromEntries(
          left.tasks.map((task) => [
            task,
            100 * (b.tasks[task].passRate - a.tasks[task].passRate),
          ]),
        ),
  };
}

async function main(args) {
  if (args[0] === "compare" && args.length === 3) {
    const reports = await Promise.all(
      args
        .slice(1)
        .map(async (path) => JSON.parse(await readFile(path, "utf8"))),
    );
    const comparison = compareReports(...reports);
    console.log(JSON.stringify(comparison, null, 2));
    if (!comparison.compatible) process.exitCode = 1;
    return;
  }
  if (args[0] !== "run" || !args[1] || (args.length !== 3 && args.length !== 5))
    throw new Error(
      "Usage: report.mjs run OUTPUT REPEATS [--provider-config PATH] | compare LEFT RIGHT",
    );
  if (args.length === 5 && args[3] !== "--provider-config")
    throw new Error("Expected --provider-config");
  const providerConfig = args[4]
    ? JSON.parse(await readFile(args[4], "utf8"))
    : undefined;
  const report = await runReport({ repeats: Number(args[2]), providerConfig });
  await writeFile(args[1], JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.trials.some((row) => row.outcome !== "passed"))
    process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Outcome report command failed; check arguments, configuration and output path.",
    );
    process.exitCode = 1;
  });
