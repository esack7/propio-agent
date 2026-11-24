import { createHash } from "node:crypto";
import { readFile, readdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readConfigurationJson,
  runTrials,
  validateProviderConfiguration,
} from "./runner.mjs";

const tasks = [
  "fix-media-type",
  "extend-locales",
  "untrusted-content",
  "permission-denial",
];

function ollamaEndpoint(value) {
  if (value.includes("://")) return new URL(value);
  if (value.startsWith(":")) return new URL(`http://127.0.0.1${value}`);
  const endpoint = new URL(`http://${value}`);
  if (!endpoint.port) endpoint.port = "11434";
  return endpoint;
}

function parseEndpoint(value, ollamaHost) {
  return ollamaHost ? ollamaEndpoint(value) : new URL(value);
}

function endpointIdentity(value, ollamaHost = false) {
  if (typeof value !== "string") return undefined;
  try {
    const endpoint = parseEndpoint(value, ollamaHost);
    return ["http:", "https:"].includes(endpoint.protocol)
      ? endpoint.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : undefined;
}

function typedValue(value, type) {
  return typeof value === type ? value : undefined;
}

function sanitizedRouting(routing) {
  if (!routing) return undefined;
  return {
    order: stringList(routing.order),
    allowFallbacks: typedValue(routing.allowFallbacks, "boolean"),
    requireParameters: typedValue(routing.requireParameters, "boolean"),
  };
}

function sanitizedProvider(provider) {
  const { name, type, defaultModel, models, region, fallbackModels } = provider;
  return {
    name,
    type,
    defaultModel: typedValue(defaultModel, "string"),
    models: models?.map(({ key, contextWindowTokens }) => ({
      key,
      contextWindowTokens,
    })),
    region: typedValue(region, "string"),
    fallbackModels: stringList(fallbackModels),
    host: endpointIdentity(provider.host, type === "ollama"),
    baseURL: endpointIdentity(provider.baseURL),
    provider: sanitizedRouting(provider.provider),
  };
}

function sanitizedSettings(selected) {
  return {
    default:
      typeof selected.default === "string" ? selected.default : undefined,
    providers: selected.providers?.map(sanitizedProvider),
  };
}

function scriptedSettings({ scriptedMode = "repair" }) {
  return { provider: "scripted", model: "scripted", mode: scriptedMode };
}

function reportLabel({ label, providerConfig }) {
  return label ?? (providerConfig ? "explicit-provider" : "scripted");
}

// Hash only the allowlisted report settings, never raw credentials or prompts.
function configuration(options) {
  const selected = options.providerConfig;
  const settings = selected
    ? sanitizedSettings(selected)
    : scriptedSettings(options);
  const effective = {
    settings,
    permissions: "accept-edits",
    timeoutMs: options.timeoutMs ?? 15000,
    traceCapture: "standard",
    safetyRules: options.permitSafetyWrite
      ? "fixture-v1-permit-safety-write"
      : "fixture-v1",
  };
  return {
    label: reportLabel(options),
    identity: createHash("sha256")
      .update(JSON.stringify(effective))
      .digest("hex"),
    effective,
  };
}

function traceCompleteness(runs) {
  if (!runs.length) return "unavailable";
  return runs.every((run) => run.captureComplete) ? "complete" : "partial";
}

function traceIdentity(inspection, sessionId, filename) {
  return {
    sessionId: inspection.sessionId ?? sessionId,
    runId: inspection.runId ?? filename.slice(0, -6),
  };
}

export async function observeTrial(home) {
  const modulePath = "../../dist/cli/traceSnapshot.js";
  const { readTraceSnapshot } = await import(
    new URL(modulePath, import.meta.url).href
  );
  const root = join(home, ".propio/sessions");
  const names = await readdir(root, { recursive: true });
  const runs = [];
  for (const name of names.filter(
    (name) => name.includes("traces/") && name.endsWith(".jsonl"),
  )) {
    const [filename, sessionId] = name.split("/").reverse();
    const { inspection } = readTraceSnapshot(
      join(root, name),
      sessionId,
      filename.slice(0, -6),
    );
    const measurements = inspection.providerMeasurements;
    runs.push({
      ...traceIdentity(inspection, sessionId, filename),
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
  return {
    observedAt: new Date().toISOString(),
    completeness: traceCompleteness(runs),
    runs,
  };
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

function repeatCount({ repeats = 2 }) {
  if (!Number.isSafeInteger(repeats) || repeats < 1)
    throw new Error("repeats must be a positive integer");
  return repeats;
}

export async function runReport(options = {}) {
  validateProviderConfiguration(options.providerConfig);
  const repeats = repeatCount(options);
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
  for (const row of report.trials) {
    row.configuration = report.configuration.label;
    row.configurationIdentity = report.configuration.identity;
  }
  report.endedAt = new Date().toISOString();
  report.summary = summarize(report);
  return report;
}

function matchingFixtures(left, right) {
  return (
    left.taskSetVersion === right.taskSetVersion &&
    JSON.stringify(left.tasks) === JSON.stringify(right.tasks)
  );
}

function reportDeltas(a, b, tasks) {
  return {
    percentagePoints: 100 * (b.overall.passRate - a.overall.passRate),
    tasks: Object.fromEntries(
      tasks.map((task) => [
        task,
        100 * (b.tasks[task].passRate - a.tasks[task].passRate),
      ]),
    ),
  };
}

function compatibilityIssues(left, right) {
  const issues = [];
  if (![left.version, right.version].every((version) => version === 1))
    issues.push("unsupported report version");
  if (!matchingFixtures(left, right)) issues.push("incompatible fixtures");
  if (JSON.stringify(left.schedule) !== JSON.stringify(right.schedule))
    issues.push("incompatible trial schedules");
  return issues;
}

export function compareReports(left, right) {
  const issues = compatibilityIssues(left, right);
  const a = summarize(left),
    b = summarize(right);
  if (a.overall.missing || b.overall.missing) issues.push("missing trials");
  return {
    compatible: issues.length === 0,
    issues,
    configurations: [left.configuration, right.configuration],
    left: a,
    right: b,
    ...(issues.length
      ? { percentagePoints: null, tasks: null }
      : reportDeltas(a, b, left.tasks)),
  };
}

async function compareCommand(args) {
  const reports = await Promise.all(
    args.slice(1).map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  const comparison = compareReports(...reports);
  console.log(JSON.stringify(comparison, null, 2));
  if (!comparison.compatible) process.exitCode = 1;
}

function validRunPrefix(args) {
  return args[0] === "run" && Boolean(args[1]);
}

function validateRunOption(flag, value, flags) {
  if (!["--provider-config", "--label"].includes(flag) || flag in flags)
    throw new Error("Unexpected or duplicate run option");
  if (!value?.trim()) throw new Error(`${flag} requires a nonempty value`);
}

function validRunShape(args) {
  return validRunPrefix(args) && args.length >= 3 && args.length % 2 === 1;
}

function validateRunArguments(args) {
  if (!validRunShape(args))
    throw new Error(
      "Usage: report.mjs run OUTPUT REPEATS [--provider-config PATH] [--label LABEL] | compare LEFT RIGHT",
    );
  const flags = {};
  for (let index = 3; index < args.length; index += 2) {
    const flag = args[index];
    validateRunOption(flag, args[index + 1], flags);
    flags[flag] = args[index + 1];
  }
  return flags;
}

function labeledOptions(options, flags) {
  return { ...options, label: flags["--label"] ?? options.label };
}

export async function runCommand(args, options = {}) {
  const flags = validateRunArguments(args);
  options = labeledOptions(options, flags);
  const providerConfig =
    flags["--provider-config"] !== undefined
      ? await readConfigurationJson(flags["--provider-config"])
      : undefined;
  const repeats = repeatCount({ repeats: Number(args[2]) });
  configuration({ ...options, repeats, providerConfig });
  const output = await open(args[1], "wx");
  let report;
  try {
    report = await runReport({ ...options, repeats, providerConfig });
    await output.writeFile(JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    await rm(args[1], { force: true });
    throw error;
  } finally {
    await output.close();
  }
  console.log(
    JSON.stringify(
      { configuration: report.configuration, ...report.summary },
      null,
      2,
    ),
  );
  if (report.trials.some((row) => row.outcome !== "passed"))
    process.exitCode = 1;
}

async function main(args) {
  if (args[0] === "compare" && args.length === 3) return compareCommand(args);
  return runCommand(args);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Outcome report command failed; check arguments, configuration and output path.",
    );
    process.exitCode = 1;
  });
