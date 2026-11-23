import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gradeCodingTrial } from "./coding.mjs";
import { runTrials } from "./runner.mjs";

async function run(t, options = {}) {
  const parent = await mkdtemp(join(tmpdir(), "propio-runner-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const rows = await runTrials({ parent, ...options });
  assert.deepEqual(await readdir(parent), [], "temporary state was removed");
  return rows;
}

test("actual CLI repairs both coding fixtures with isolated homes and workspaces", async (t) => {
  const homes = new Set();
  const workspaces = new Set();
  const rows = await run(t, {
    beforeRun: async ({ home, workspace }) => {
      homes.add(home);
      workspaces.add(workspace);
    },
  });
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ["passed", "passed"],
  );
  assert.equal(homes.size, 2);
  assert.equal(workspaces.size, 2);
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
  [
    "nonzero exit",
    { cliPath: "/nonexistent/propio-cli.js" },
    "error",
    /CLI exited/,
  ],
  ["timeout", { scriptedMode: "hang", timeoutMs: 1500 }, "error", /timed out/],
]) {
  test(`${name} produces a bounded visible outcome`, async (t) => {
    const rows = await run(t, { tasks: ["fix-media-type"], ...options });
    assert.equal(rows[0].outcome, outcome);
    assert.match(rows[0].reason, reason);
  });
}
