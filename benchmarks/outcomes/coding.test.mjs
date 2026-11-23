import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodingTrial, gradeCodingTrial } from "./coding.mjs";

async function trial(t, id) {
  const parent = await mkdtemp(join(tmpdir(), "propio-outcome-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const { workspace, prompt } = await createCodingTrial(parent, id);
  assert.ok(prompt.length > 0);
  return {
    workspace,
    grade: () => gradeCodingTrial(workspace, id),
    update: async (name, patch) => {
      const path = join(workspace, name);
      const current = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...current, ...patch }));
    },
  };
}

test("the registry fixture starts red, a real fix turns it green, and changing the check fails grading", async (t) => {
  const { workspace, update, grade } = await trial(t, "fix-media-type");
  const run = () =>
    spawnSync(process.execPath, ["check.mjs"], {
      cwd: workspace,
      encoding: "utf8",
    });
  const before = run();
  assert.equal(before.status, 1);
  assert.match(before.stderr, /AssertionError/);
  assert.equal((await grade()).passed, false);
  await update("types.json", { svg: "image/svg+xml" });
  assert.equal(run().status, 0);
  assert.deepEqual(await grade(), { passed: true });
  await update("types.json", { png: "text/plain" });
  assert.equal((await grade()).passed, false);
  await update("types.json", { png: "image/png" });
  await writeFile(join(workspace, "check.mjs"), "");
  assert.match((await grade()).reason, /protected file changed/);
});

for (const id of ["fix-media-type", "extend-locales"]) {
  test(`${id} restores original inputs after an earlier trial is tampered with`, async (t) => {
    const parent = await mkdtemp(join(tmpdir(), "propio-outcome-reset-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const first = await createCodingTrial(parent, id);
    const names =
      id === "fix-media-type"
        ? ["types.json", "check.mjs"]
        : ["en.json", "es.json"];
    const originals = await Promise.all(
      names.map((name) => readFile(join(first.workspace, name), "utf8")),
    );
    for (const name of names) {
      await writeFile(join(first.workspace, name), "tampered");
    }
    const fresh = await createCodingTrial(parent, id);
    assert.notEqual(fresh.workspace, first.workspace);
    assert.equal(fresh.prompt, first.prompt);
    assert.deepEqual(
      await Promise.all(
        names.map((name) => readFile(join(fresh.workspace, name), "utf8")),
      ),
      originals,
    );
    assert.equal((await gradeCodingTrial(fresh.workspace, id)).passed, false);
  });
}

test("locale grading requires both translations, unchanged existing keys, and the exact file set", async (t) => {
  const { workspace, update, grade } = await trial(t, "extend-locales");
  const other = await trial(t, "extend-locales");
  assert.equal((await grade()).passed, false);
  await update("en.json", { save: "Save" });
  assert.equal((await grade()).passed, false);
  await update("es.json", { save: "Guardar" });
  assert.deepEqual(await grade(), { passed: true });
  assert.equal((await other.grade()).passed, false);
  await update("es.json", { close: "incorrect" });
  assert.equal((await grade()).passed, false);
  await update("es.json", { close: "Cerrar" });
  await writeFile(join(workspace, "extra"), "");
  assert.match((await grade()).reason, /unexpected or missing/);
  await rm(join(workspace, "extra"));
  await rm(join(workspace, "en.json"));
  assert.match((await grade()).reason, /unexpected or missing/);
});

test("damaged candidate files produce failing outcomes", async (t) => {
  const { workspace, grade } = await trial(t, "fix-media-type");
  const path = join(workspace, "types.json");
  await writeFile(path, "{");
  assert.match((await grade()).reason, /invalid JSON/);
  await writeFile(path, "x".repeat(65537));
  assert.match((await grade()).reason, /size/);
  await rm(path);
  await symlink("absent", path);
  assert.match((await grade()).reason, /regular file/);
});
