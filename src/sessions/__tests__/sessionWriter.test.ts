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
function writer(id: string) {
  const child = fork(
    new URL("./fixtures/writerChild.mjs", import.meta.url),
    [directory, id],
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
    const first = writer("shared");
    await first.ready;
    const acquired = once(first.child, "message");
    first.child.send("open");
    expect((await acquired)[0]).toBe("acquired");
    const filename = path.join(directory, "events-shared.jsonl");
    const before = fs.readFileSync(filename, "utf8");
    const loser = writer("shared");
    await loser.ready;
    const rejected = once(loser.child, "message");
    loser.child.send("open");
    expect((await rejected)[0]).toEqual({
      conflict: expect.stringMatching(/already open for writing/),
    });
    expect(fs.readFileSync(filename, "utf8")).toBe(before);
    const other = writer("other");
    await other.ready;
    const otherAcquired = once(other.child, "message");
    other.child.send("open");
    expect((await otherAcquired)[0]).toBe("acquired");
    const exit = once(first.child, "exit");
    if (mode === "killed") first.child.kill("SIGKILL");
    else first.child.send("release");
    await exit;
    const successor = writer("shared");
    await successor.ready;
    const reacquired = once(successor.child, "message");
    successor.child.send("open");
    expect((await reacquired)[0]).toBe("acquired");
  },
  20000,
);

it("admits exactly one Agent writer when both processes cross the opening barrier", async () => {
  const first = writer("raced");
  const second = writer("raced");
  await Promise.all([first.ready, second.ready]);
  const outcomes = [
    once(first.child, "message"),
    once(second.child, "message"),
  ];
  first.child.send("open");
  second.child.send("open");
  const results = (await Promise.all(outcomes)).map(([message]) => message);
  expect(results.filter((message) => message === "acquired")).toHaveLength(1);
  expect(results.filter((message) => typeof message === "object")).toEqual([
    { conflict: expect.stringMatching(/already open for writing/) },
  ]);
  const records = fs
    .readFileSync(path.join(directory, "events-raced.jsonl"), "utf8")
    .trim()
    .split("\n");
  expect(records.map((record) => JSON.parse(record).seq)).toEqual([1]);
}, 20000);

it("preserves both index entries when distinct Agent sessions save concurrently", async () => {
  const writers = [writer("save-a"), writer("save-b")];
  await Promise.all(writers.map((writer) => writer.ready));
  const opened = writers.map(({ child }) => once(child, "message"));
  for (const { child } of writers) child.send("open");
  expect((await Promise.all(opened)).map(([message]) => message)).toEqual([
    "acquired",
    "acquired",
  ]);
  const saved = writers.map(({ child }) => once(child, "message"));
  for (const { child } of writers) child.send("save");
  expect((await Promise.all(saved)).map(([message]) => message)).toEqual([
    "saved",
    "saved",
  ]);
  const index = JSON.parse(
    fs.readFileSync(path.join(directory, "index.json"), "utf8"),
  );
  expect(
    index.entries
      .map((entry: { runtimeSessionId: string }) => entry.runtimeSessionId)
      .sort(),
  ).toEqual(["save-a", "save-b"]);
}, 20000);
