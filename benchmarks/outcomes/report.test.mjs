import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";
import { startScriptedProvider } from "./scripted.mjs";
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

function reportHost(persisted) {
  return JSON.parse(persisted).configuration.effective.settings.providers[0]
    .host;
}

function providerSelection(configuration, variant) {
  return variant === "defaultModel"
    ? configuration.providers[0]
    : configuration;
}

function assertProviderSelection(report, variant, provider) {
  assert.equal(
    report.trials[0].outcome,
    variant === "valid" ? "passed" : "error",
  );
  if (variant === "valid") {
    assert.ok(provider.received.length > 0);
  } else {
    assert.equal(
      providerSelection(report.configuration.effective.settings, variant)[
        variant
      ],
      undefined,
    );
  }
}

for (const variant of ["valid", "default", "defaultModel"]) {
  test(`explicit provider report sanitizes ${variant} selection`, async () => {
    const root = await mkdtemp(join(tmpdir(), "outcome-explicit-report-"));
    const provider = await startScriptedProvider("fix-media-type");
    const originalExitCode = process.exitCode;
    const config = join(root, "provider.json");
    const selected = {
      default: "local",
      providers: [
        {
          name: "local",
          type: "ollama",
          host: provider.host,
          apiKey: "SECRET_API_CANARY",
          customOption: "SECRET_OPTION_CANARY",
          models: [
            { name: "Harness", key: "scripted", contextWindowTokens: 32768 },
          ],
          defaultModel: "scripted",
        },
      ],
    };
    try {
      const configuration = structuredClone(selected);
      const selection = providerSelection(configuration, variant);
      if (variant !== "valid")
        selection[variant] = { apiKey: "SECRET_SELECTION_CANARY" };
      await writeFile(config, JSON.stringify(configuration));
      const output = join(root, `${variant}.json`);
      await runCommand(
        [
          "run",
          output,
          "1",
          "--provider-config",
          config,
          "--label",
          "local-evaluation",
        ],
        {
          tasks: ["fix-media-type"],
          label: "local-evaluation",
        },
      );
      const persisted = await readFile(output, "utf8");
      assert.equal(persisted.includes("SECRET_"), false);
      assert.equal(reportHost(persisted), provider.host);
      const report = JSON.parse(persisted);
      assert.equal(report.configuration.label, "local-evaluation");
      assert.match(report.configuration.identity, /^[a-f0-9]{64}$/);
      assert.equal(
        report.trials[0].configurationIdentity,
        report.configuration.identity,
      );
      assertProviderSelection(report, variant, provider);
    } finally {
      process.exitCode = originalExitCode;
      await provider.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
    const emptyRun = (await observeTrial(home)).runs[0];
    assert.equal(emptyRun.captureComplete, false);
    assert.equal(emptyRun.runId, "run");
    assert.equal(emptyRun.sessionId, "session");
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

test("behavior settings distinguish identities without retaining endpoint secrets", async () => {
  const provider = {
    name: "local",
    type: "ollama",
    models: [],
    host: "https://user:SECRET_PASSWORD@example.com/SECRET_PATH?token=SECRET_QUERY",
    apiKey: "SECRET_KEY",
  };
  const report = (changes) =>
    runReport({
      tasks: [],
      providerConfig: { providers: [{ ...provider, ...changes }] },
    });
  const baseline = await report({});
  for (const changes of [
    { region: "us-west-2" },
    { fallbackModels: ["other"] },
    { provider: { order: ["other"] } },
    { host: "https://other.example.com" },
  ]) {
    assert.notEqual(
      (await report(changes)).configuration.identity,
      baseline.configuration.identity,
    );
  }
  assert.equal(JSON.stringify(baseline).includes("SECRET_"), false);
  assert.equal(
    baseline.configuration.effective.settings.providers[0].host,
    "https://example.com",
  );
  assert.equal(
    (await report({ apiKey: "different-secret" })).configuration.identity,
    baseline.configuration.identity,
  );
  const serverA = await report({ host: "gpu-a:11434" });
  const serverB = await report({ host: "gpu-b:11434" });
  assert.notEqual(
    serverA.configuration.identity,
    serverB.configuration.identity,
  );
  for (const [host, expected] of [
    ["gpu-a:11434", "http://gpu-a:11434"],
    ["127.0.0.1:11434", "http://127.0.0.1:11434"],
    [":11434", "http://127.0.0.1:11434"],
    ["gpu-a", "http://gpu-a:11434"],
    ["user:SECRET_PASSWORD@gpu-a:11434", "http://gpu-a:11434"],
  ]) {
    const result = await report({ host });
    assert.equal(
      result.configuration.effective.settings.providers[0].host,
      expected,
    );
    assert.equal(JSON.stringify(result).includes("SECRET_"), false);
  }
});

test("empty provider path is rejected before trials or output creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "outcome-empty-provider-"));
  try {
    const output = join(root, "report.json");
    let started = false;
    await assert.rejects(
      runCommand(["run", output, "2", "--provider-config", ""], {
        beforeRun: () => {
          started = true;
        },
      }),
      /nonempty/,
    );
    assert.equal(started, false);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
