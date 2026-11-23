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
it.each(["--show-turn-details", "--show-trace"])(
  "accepts %s with capture in credential-free help without startup",
  (flag) => {
    const result = cli(["--help", flag, "--trace-capture", "standard"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    for (const name of [
      "--trace-capture",
      "--show-turn-details",
      "--show-trace",
    ])
      expect(result.stdout).toContain(name);
  },
);
it("rejects invalid CLI capture before provider initialization", () => {
  const result = cli(["--json", "--trace-capture=off"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("--trace-capture requires standard or full");
});

it("keeps session commands and failure hints on the startup trace root without credentials", () => {
  const source = (file: string) =>
    new URL(file, new URL("../../../", import.meta.url)).href;
  const script = `
    import { handleInteractiveSubmission, runNonInteractiveSession, runInteractiveTurn } from ${JSON.stringify(source("src/index.ts"))};
    import { getDefaultSessionsDir } from ${JSON.stringify(source("src/sessions/sessionHistory.ts"))};
    import { TerminalUi } from ${JSON.stringify(source("src/ui/terminal.ts"))};
    import { createPlainSubmission } from ${JSON.stringify(source("src/ui/input/promptSubmission.ts"))};
    import { PassThrough } from 'node:stream';
    import { execFileSync } from 'node:child_process';
    import { dirname } from 'node:path';
    const sessionsDir = getDefaultSessionsDir();
    execFileSync('git', ['init', '-q', dirname(process.cwd())], { stdio: 'pipe' });
    if (sessionsDir === getDefaultSessionsDir()) throw new Error('fixture did not change the workspace root');
    const lines = [];
    const sink = { isTTY: false, write(text) { lines.push(String(text)); return true; }, on() {}, off() {} };
    const errors = [];
    const errorSink = { ...sink, write(text) { errors.push(String(text)); return true; } };
    const ui = new TerminalUi({ interactive: false, plain: true, json: false, stdout: sink, stderr: errorSink });
    let controller;
    let runId = 'run';
    const agent = {
      getSessionTraceIdentity: () => ({ sessionId: 'session', runId }),
      streamChat: async () => {
        runId = 'run';
        controller?.abort();
        throw new Error('fixture foreground failure');
      },
      getLastTurnReasoningSummary: () => null,
      getConversationState: () => ({ preamble: [], turns: [], artifacts: [], pinnedMemory: [], invokedSkills: [], rollingSummary: null }),
    };
    const visibility = { showToolCalls: false, showThinking: false, showStatus: false, showReasoningSummary: false, showContextStats: false, showPromptPlan: false };
    const context = { agent, ui, composer: {}, configPath: 'unused', sessionsDir, inputStream: new PassThrough(), interactiveInput: false, setCurrentAbortController() {}, cancelActiveTurn() {}, shouldExit: () => false, getVisibility: () => visibility };
    await handleInteractiveSubmission(createPlainSubmission('/trace', 'prompt'), context);
    await handleInteractiveSubmission(createPlainSubmission('/usage', 'prompt'), context);
    const sessionOutput = [...lines.splice(0), ...errors.splice(0)].join('');
    const jsonLines = [];
    const jsonSink = { ...sink, write(text) { jsonLines.push(String(text)); return true; } };
    const jsonUi = new TerminalUi({ interactive: false, plain: true, json: true, stdout: jsonSink, stderr: jsonSink });
    const deps = { stdinIsTTY: false, readInput: async () => 'fail', sessionsDir };
    runId = undefined;
    const code = await runNonInteractiveSession(agent, jsonUi, () => {}, visibility, deps);
    runId = undefined;
    await runNonInteractiveSession(agent, ui, () => {}, visibility, deps);
    const pipeError = errors.splice(0).join('');
    runId = undefined;
    await runInteractiveTurn(createPlainSubmission('fail', 'prompt'), context, { errorPrefix: 'Error: ' });
    const interactiveError = errors.splice(0).join('');
    runId = undefined;
    const cancelCode = await runNonInteractiveSession(agent, ui, (active) => { controller = active; }, visibility, deps);
    console.log(JSON.stringify({ sessionOutput, code, json: jsonLines.join(''), pipeError, interactiveError, cancelCode, cancelledStderr: errors.join('') }));
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(repo, "node_modules/tsx/dist/loader.mjs"),
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        NODE_NO_WARNINGS: "1",
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.code).toBe(1);
  expect(output.sessionOutput).toContain("Run run (session session)");
  expect(output.sessionOutput).toContain("Session session: 1 runs");
  for (const error of [output.pipeError, output.interactiveError]) {
    expect(error).toContain("fixture foreground failure");
    expect(error).toContain("propio trace show 'run' --session 'session'");
  }
  expect(output.cancelCode).toBe(130);
  expect(output.cancelledStderr).toBe("");
  expect(JSON.parse(output.json)).toEqual({
    error: "fixture foreground failure",
    trace: {
      available: true,
      sessionId: "session",
      runId: "run",
      complete: true,
      command: "propio trace show 'run' --session 'session'",
    },
  });
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  for (const command of ["trace", "usage"])
    expect(readme).toMatch(new RegExp("^\\| `/" + command + "`\\s*\\|", "m"));
});
