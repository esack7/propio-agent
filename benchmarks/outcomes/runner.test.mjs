import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gradeCodingTrial } from "./coding.mjs";
import { startScriptedProvider } from "./scripted.mjs";
import { runTrials } from "./runner.mjs";

async function run(t, options = {}) {
  const parent = await mkdtemp(join(tmpdir(), "propio-runner-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const rows = await runTrials({
    parent,
    tasks: ["fix-media-type", "extend-locales"],
    ...options,
  });
  assert.deepEqual(await readdir(parent), [], "temporary state was removed");
  return rows;
}

test("actual CLI passes all four default fixtures with isolated homes and workspaces", async (t) => {
  const homes = new Set();
  const workspaces = new Set();
  const rows = await run(t, {
    tasks: undefined,
    beforeRun: async ({ home, workspace }) => {
      homes.add(home);
      workspaces.add(workspace);
    },
  });
  assert.deepEqual(
    rows.map((row) => row.task),
    [
      "fix-media-type",
      "extend-locales",
      "untrusted-content",
      "permission-denial",
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ["passed", "passed", "passed", "passed"],
  );
  assert.equal(homes.size, 4);
  assert.equal(workspaces.size, 4);
  assert.ok(
    rows.every((row) => row.configuration === "scripted" && row.code === 0),
  );
});

test("missing startup workspace is visible and the next scheduled CLI trial runs", async (t) => {
  const rows = await run(t, {
    beforeRun: async ({ workspace, index }) => {
      if (index === 0) await rm(workspace, { recursive: true });
    },
  });
  assert.equal(rows[0].outcome, "error");
  assert.match(rows[0].reason, /launch failed/);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].task, "extend-locales");
  assert.equal(rows[1].trial, 2);
  assert.equal(rows[1].code, 0);
  assert.equal(rows[1].outcome, "passed");
});

test("grader I/O failure is visible and the next scheduled CLI trial runs", async (t) => {
  let brokenPath;
  const rows = await run(t, {
    gradeTrial: (workspace, task) =>
      gradeCodingTrial(brokenPath ?? workspace, task),
    beforeGrade: async ({ workspace, root, index }) => {
      brokenPath = undefined;
      if (index !== 0) return;
      // A symlink loop makes lstat fail with ELOOP even when tests run as root.
      await rm(workspace, { recursive: true });
      const loop = join(root, "loop");
      await symlink("loop", loop);
      brokenPath = join(loop, "workspace");
    },
  });
  assert.equal(rows[0].outcome, "error");
  assert.match(rows[0].reason, /ELOOP/);
  assert.equal(rows[0].code, 0, "CLI completed before grading failed");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].task, "extend-locales");
  assert.equal(rows[1].trial, 2);
  assert.equal(rows[1].code, 0);
  assert.equal(rows[1].outcome, "passed");
});

for (const [name, options, outcome, reason] of [
  ["no-op", { scriptedMode: "noop" }, "failed", /catalog values differ/],
  ["nonzero exit", { scriptedMode: "fail" }, "error", /CLI exited/],
  ["timeout", { scriptedMode: "hang", timeoutMs: 1500 }, "error", /timed out/],
]) {
  test(`${name} produces a bounded visible outcome`, async (t) => {
    const rows = await run(t, { tasks: ["fix-media-type"], ...options });
    assert.equal(rows[0].outcome, outcome);
    assert.match(rows[0].reason, reason);
  });
}

for (const kind of [
  "argument",
  "configuration",
  "null",
  "false",
  "0",
  '""',
  "[]",
  '"text"',
]) {
  test(`${kind} errors do not echo credentials`, async (t) => {
    const { spawnSync } = await import("node:child_process");
    const { writeFile } = await import("node:fs/promises");
    const parent = await mkdtemp(join(tmpdir(), "propio-config-test-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const secret = "synthetic-secret-never-print";
    const path = join(parent, "provider.json");
    await writeFile(
      path,
      kind === "configuration" || kind === "argument"
        ? `{ "apiKey": "${secret}", invalid }`
        : kind,
    );
    const args = kind === "argument" ? [secret] : ["--provider-config", path];
    const result = spawnSync(
      process.execPath,
      ["benchmarks/outcomes/runner.mjs", ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.length > 0);
    assert.ok(!result.stderr.includes(secret));
  });
}

for (const workspaceOnly of [true, false]) {
  test(`built CLI ${workspaceOnly ? "excludes" : "retains"} ancestor instructions with explicit loopback config`, async (t) => {
    const parent = await mkdtemp(join(tmpdir(), "propio-instructions-test-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const marker = "INERT_ANCESTOR_INSTRUCTION_MARKER";
    const control = "INERT_WORKSPACE_INSTRUCTION_CONTROL";
    await writeFile(join(parent, "AGENTS.md"), marker);
    const provider = await startScriptedProvider("fix-media-type");
    t.after(() => provider.close());
    const cliPath = join(parent, "ordinary-cli.mjs");
    if (!workspaceOnly) {
      const entry = new URL("../../bin/propio.cjs", import.meta.url).href;
      await writeFile(
        cliPath,
        `process.argv = process.argv.filter(arg => arg !== "--workspace-instructions-only");
await import(${JSON.stringify(entry)});`,
      );
    }
    const rows = await runTrials({
      parent,
      tasks: ["fix-media-type"],
      ...(workspaceOnly ? {} : { cliPath }),
      providerConfig: {
        default: "loopback",
        providers: [
          {
            name: "loopback",
            type: "ollama",
            host: provider.host,
            models: [
              { name: "Scripted", key: "scripted", contextWindowTokens: 32768 },
            ],
            defaultModel: "scripted",
          },
        ],
      },
      beforeRun: ({ workspace }) =>
        writeFile(join(workspace, "AGENTS.md"), control),
      // The extra control file is deliberately outside the coding fixture manifest.
      beforeGrade: ({ workspace }) => rm(join(workspace, "AGENTS.md")),
    });
    assert.equal(rows[0].configuration, "explicit-provider");
    assert.equal(rows[0].outcome, "passed");
    assert.ok(provider.received.length >= 2);
    for (const request of provider.received) {
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      assert.ok(system.includes(control));
      assert.equal(system.includes(marker), !workspaceOnly);
    }
  });
}
