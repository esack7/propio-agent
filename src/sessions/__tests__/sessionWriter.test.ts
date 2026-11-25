import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";

let directory: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "session-writer-"));
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
  }
  fs.rmSync(directory, { recursive: true, force: true });
});
function writer(id: string, marker: string) {
  const child = fork(
    new URL("./fixtures/writerChild.mjs", import.meta.url),
    [directory, id, path.join(directory, marker)],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  children.push(child);
  return { child, ready: once(child, "message") };
}

it.each(["graceful", "killed"])(
  "excludes a competing process and releases after %s exit",
  async (mode) => {
    const first = writer("shared", "first");
    expect((await first.ready)[0]).toBe("acquired");
    const loser = writer("shared", "loser");
    expect((await loser.ready)[0]).toEqual({
      conflict: expect.stringMatching(/already open for writing/),
    });
    expect(fs.existsSync(path.join(directory, "loser"))).toBe(false);
    const other = writer("other", "other");
    expect((await other.ready)[0]).toBe("acquired");
    const exit = once(first.child, "exit");
    if (mode === "killed") first.child.kill("SIGKILL");
    else first.child.send("release");
    await exit;
    const successor = writer("shared", "successor");
    expect((await successor.ready)[0]).toBe("acquired");
  },
  20000,
);
