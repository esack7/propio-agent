import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
let directory: string;
let workspace: string;
let home: string;
let journal: string;
beforeEach(() => {
  directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "trace-startup-")),
  );
  workspace = path.join(directory, "workspace");
  home = path.join(directory, "home");
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(home, ".propio"), { recursive: true });
  // Ordinary startup must reject these. Offline routing must never load them.
  for (const config of ["providers.json", "mcp.json", "settings.json"])
    fs.writeFileSync(path.join(home, ".propio", config), "not valid JSON");
  const hash = createHash("sha256").update(workspace).digest("hex");
  journal = path.join(
    home,
    ".propio",
    "sessions",
    hash,
    "traces",
    "session",
    "run.jsonl",
  );
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.writeFileSync(
    journal,
    ["turn_started", "turn_completed"]
      .map(
        (type, i) =>
          JSON.stringify({
            version: 1,
            eventId: `event-${i}`,
            sequence: i + 1,
            observedAt: "2026-11-14T10:00:00Z",
            monotonicNanoseconds: String(i * 1_000_000),
            component: "agent",
            type,
            identity: {
              sessionId: "session",
              runId: "run",
              operationId: "turn",
            },
            payload: {},
          }) + "\n",
      )
      .join(""),
  );
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
function cli(args: string[], cwd = workspace) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      path.join(repo, "node_modules", "tsx", "dist", "loader.mjs"),
      path.join(repo, "src", "index.ts"),
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        NODE_NO_WARNINGS: "1",
        PROPIO_TRACE_CAPTURE_LEVEL: "invalid-startup-only-setting",
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
}
it("runs list/show/export/verify with no credentials and unusable startup configuration", () => {
  const list = cli(["trace", "list", "--json"]);
  expect(list.stderr).toBe("");
  expect(list.status).toBe(0);
  expect(JSON.parse(list.stdout).runs[0].runId).toBe("run");
  const show = cli(["trace", "show", "run", "--json"]);
  expect(show.stderr).toBe("");
  expect(show.status).toBe(0);
  expect(JSON.parse(show.stdout).timeline).toHaveLength(2);
  const destination = path.join(directory, "export");
  const exported = cli([
    "trace",
    "export",
    "run",
    "--output",
    destination,
    "--json",
  ]);
  expect(exported.stderr).toBe("");
  expect(exported.status).toBe(0);
  expect(JSON.parse(exported.stdout).manifest.captureLevel).toBe("standard");
  const verified = cli(["trace", "verify", destination, "--json"]);
  expect(verified.stderr).toBe("");
  expect(verified.status).toBe(0);
  expect(JSON.parse(verified.stdout).valid).toBe(true);
  fs.appendFileSync(path.join(destination, "events.jsonl"), "tampered");
  const invalid = cli(["trace", "verify", destination, "--json"]);
  expect(invalid.status).toBe(1);
  expect(JSON.parse(invalid.stdout).valid).toBe(false);
}, 30000);
it("scopes discovery to the current workspace and leaves JSON errors on stderr", () => {
  const other = path.join(directory, "other");
  fs.mkdirSync(other);
  const list = cli(["trace", "list", "--json"], other);
  expect(list.status).toBe(0);
  expect(JSON.parse(list.stdout).runs).toEqual([]);
  const missing = cli(["trace", "show", "run", "--json"], other);
  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).toContain("not found");
});
it("prints trace help without normal startup", () => {
  const help = cli(["trace", "--help"]);
  expect(help.status).toBe(0);
  expect(help.stderr).toBe("");
  expect(help.stdout).toContain("propio trace list");
});
