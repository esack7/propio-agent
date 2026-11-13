import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BashTool } from "../bash.js";
import { runShellCommand } from "../runShellCommand.js";

// Real processes: the point is what the operating system does with the
// command's descendants, which a mocked child cannot show.

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
const node = quote(process.execPath);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

const waitUntilDead = (pid: number) =>
  waitFor(() => (isAlive(pid) ? undefined : true));

describe("shell command process group", () => {
  let dir: string;
  let pidFile: string;
  const started: number[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-process-group-"));
    pidFile = path.join(dir, "child.pid");
  });

  afterEach(() => {
    // A failing assertion must not leave a test's child running.
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, which is what the test expects.
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A child that records its pid once it is ready, then idles. */
  const idleChild = (ignoreSigterm: boolean) =>
    `${node} -e ${quote(
      `${ignoreSigterm ? 'process.on("SIGTERM", () => {});' : ""}
       require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       setInterval(() => {}, 1000);`,
    )}`;

  async function childPid(): Promise<number> {
    const pid = await waitFor(() => readPid(pidFile));
    started.push(pid);
    return pid;
  }

  it("terminates a background child of the shell when cancelled", async () => {
    const controller = new AbortController();
    const pending = runShellCommand({
      command: `${idleChild(false)} & wait`,
      abortSignal: controller.signal,
    });
    const pid = await childPid();
    expect(isAlive(pid)).toBe(true);

    controller.abort();
    const result = await pending;

    expect(result.aborted).toBe(true);
    await waitUntilDead(pid);
  });

  it("terminates what a bash tool call started when the call is cancelled", async () => {
    const controller = new AbortController();
    const pending = new BashTool().executeWithStatus(
      { command: `${idleChild(false)} & wait` },
      { signal: controller.signal },
    );
    const pid = await childPid();

    controller.abort();
    const result = await pending;

    expect(result.outcome).toMatchObject({
      kind: "command",
      classification: "cancelled",
    });
    await waitUntilDead(pid);
  });

  it("kills a child that ignores SIGTERM after the grace period", async () => {
    const controller = new AbortController();
    const pending = runShellCommand({
      command: `${idleChild(true)} & wait`,
      abortSignal: controller.signal,
      killGraceMs: 200,
    });
    const pid = await childPid();

    const cancelledAt = Date.now();
    controller.abort();
    const result = await pending;

    expect(result.aborted).toBe(true);
    // The child holds the command's output open until it is killed, so the
    // result cannot arrive before the escalation.
    expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(150);
    await waitUntilDead(pid);
  });

  it("terminates the group when the command times out", async () => {
    const pending = runShellCommand({
      command: `${idleChild(false)} & wait`,
      abortSignal: new AbortController().signal,
      timeoutMs: 1500,
    });
    const pid = await childPid();

    const result = await pending;

    expect(result.timedOut).toBe(true);
    await waitUntilDead(pid);
  });

  it("terminates the group when the output cap is exceeded", async () => {
    const pending = runShellCommand({
      command: `${idleChild(false)} & while [ ! -s ${quote(pidFile)} ]; do sleep 0.05; done; ${node} -e 'process.stdout.write("x".repeat(4096))'; wait`,
      abortSignal: new AbortController().signal,
      maxBuffer: 16,
    });
    const pid = await childPid();

    const result = await pending;

    expect(result.maxBufferExceeded).toBe(true);
    await waitUntilDead(pid);
  });

  it("leaves a command that finishes on its own unaffected", async () => {
    const result = await runShellCommand({
      command: "printf done",
      abortSignal: new AbortController().signal,
    });
    expect(result).toMatchObject({ stdout: "done", exitCode: 0 });
    expect(result.aborted).toBeUndefined();
  });
});
