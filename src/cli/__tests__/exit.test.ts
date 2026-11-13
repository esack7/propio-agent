import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("./fixtures/shellExitChild.mjs", import.meta.url),
);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("CLI exit with a shell command running", () => {
  let dir: string;
  let pidFile: string;
  const leftovers: number[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-shell-exit-"));
    pidFile = path.join(dir, "child.pid");
  });

  afterEach(() => {
    for (const pid of leftovers.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone, as expected.
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function start(mode: string) {
    const cli = spawn(
      process.execPath,
      ["--import", "tsx", fixture, mode, pidFile],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = new Promise<number | null>((resolve) =>
      cli.on("exit", (code) => resolve(code)),
    );
    const pid = await waitFor(() => {
      try {
        const value = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10);
        return value > 0 ? value : undefined;
      } catch {
        return undefined;
      }
    });
    leftovers.push(pid);
    return { cli, exited, pid };
  }

  it("Ctrl+C stops a child that ignores SIGTERM and SIGINT before exiting", async () => {
    const { cli, exited, pid } = await start("sigint");

    cli.kill("SIGINT");
    const code = await exited;

    expect(code).toBe(130);
    // Checked the moment the CLI is gone: nothing may be left to clean up.
    expect(isAlive(pid)).toBe(false);
  }, 20000);

  it("Ctrl+C lets a child finish its SIGTERM cleanup before the CLI exits", async () => {
    const { cli, exited, pid } = await start("graceful");

    cli.kill("SIGINT");
    const code = await exited;

    expect(code).toBe(130);
    expect(isAlive(pid)).toBe(false);
    expect(fs.existsSync(`${pidFile}.cleaned`)).toBe(true);
  }, 20000);

  it("a second Ctrl+C while waiting kills the child and exits at once", async () => {
    const { cli, exited, pid } = await start("sigint");

    cli.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const secondAt = Date.now();
    cli.kill("SIGINT");
    const code = await exited;

    expect(code).toBe(130);
    expect(Date.now() - secondAt).toBeLessThan(1500);
    expect(isAlive(pid)).toBe(false);
  }, 20000);

  it("an exit that skips the drain still kills the child", async () => {
    const { cli, exited, pid } = await start("exit");

    cli.kill("SIGUSR2");
    const code = await exited;

    expect(code).toBe(1);
    expect(isAlive(pid)).toBe(false);
  }, 20000);
});
