import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { EventEmitter } from "events";

jest.unstable_mockModule("child_process", () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

jest.unstable_mockModule("util", () => ({
  promisify: jest.fn(),
}));

const mockExecFileAsync = jest.fn();
const { execFile, spawn } = await import("child_process");
const util = await import("util");
jest.mocked(util.promisify).mockReturnValue(mockExecFileAsync as never);

const {
  runShellCommand,
  normalizeExecErrorCode,
  MAXBUFFER_TRUNCATION_MESSAGE,
} = await import("../runShellCommand.js");

function createMockChildProcess(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
} {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: jest.fn(),
  }) as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
  };
}

describe("runShellCommand", () => {
  beforeEach(() => {
    jest.mocked(execFile).mockClear();
    jest.mocked(spawn).mockClear();
    mockExecFileAsync.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("uses execFile when no abort signal is provided", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "ok", stderr: "" });

    const result = await runShellCommand({ command: "echo ok" });

    expect(result).toMatchObject({ stdout: "ok", stderr: "", exitCode: 0 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports timeout failures from execFile", async () => {
    mockExecFileAsync.mockRejectedValue({
      killed: true,
      stdout: "partial",
      stderr: "",
    });

    const result = await runShellCommand({ command: "sleep 10", timeoutMs: 1 });

    expect(result).toMatchObject({
      stdout: "partial",
      stderr: "Command timed out and was killed",
      exitCode: -1,
      timedOut: true,
    });
  });

  it("maps string execFile error codes to -1 with a useful stderr message", async () => {
    mockExecFileAsync.mockRejectedValue({
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      killed: true,
      stdout: "partial",
      stderr: "",
      message: "stdout maxBuffer length exceeded",
    });

    const result = await runShellCommand({
      command: "yes",
      maxBuffer: 8,
    });

    expect(result.exitCode).toBe(-1);
    expect(result.maxBufferExceeded).toBe(true);
    expect(result.timedOut).toBeUndefined();
    expect(result.stdout).toBe("partial");
    expect(result.stderr).toContain(MAXBUFFER_TRUNCATION_MESSAGE);
    expect(normalizeExecErrorCode("ERR_CHILD_PROCESS_STDIO_MAXBUFFER")).toBe(
      -1,
    );
  });

  it("kills spawned commands that exceed maxBuffer and reports truncation", async () => {
    const child = createMockChildProcess();
    jest.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = runShellCommand({
      command: "yes",
      maxBuffer: 4,
      abortSignal: new AbortController().signal,
    });

    child.stdout.emit("data", Buffer.from("abcdefgh"));
    child.emit("close", null);

    await expect(resultPromise).resolves.toMatchObject({
      stdout: "abcd",
      stderr: MAXBUFFER_TRUNCATION_MESSAGE,
      exitCode: -1,
      maxBufferExceeded: true,
    });
    expect(child.kill).toHaveBeenCalled();
  });

  it("decodes UTF-8 sequences split across pipe chunks", async () => {
    const child = createMockChildProcess();
    jest.mocked(spawn).mockReturnValue(child as never);
    const pending = runShellCommand({
      command: "unicode",
      abortSignal: new AbortController().signal,
    });
    const bytes = Buffer.from("€😀");
    for (const byte of bytes) child.stdout.emit("data", Buffer.from([byte]));
    child.emit("close", 0);
    expect((await pending).stdout).toBe("€😀");
  });

  it("kills spawned commands when aborted", async () => {
    const child = createMockChildProcess();
    jest.mocked(spawn).mockReturnValue(child as never);

    const controller = new AbortController();
    const resultPromise = runShellCommand({
      command: "sleep 10",
      abortSignal: controller.signal,
    });

    controller.abort();
    child.emit("close", null);

    await expect(resultPromise).resolves.toMatchObject({
      stdout: "",
      stderr: "Command cancelled",
      exitCode: -1,
      aborted: true,
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("starts cancellable commands in their own process group", async () => {
    const child = createMockChildProcess();
    jest.mocked(spawn).mockReturnValue(child as never);
    const pending = runShellCommand({
      command: "true",
      abortSignal: new AbortController().signal,
    });
    child.emit("close", 0);
    await pending;
    expect(jest.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({
      detached: true,
    });
  });

  it("escalates to SIGKILL only while the group still has members", async () => {
    jest.useFakeTimers();
    const signals: Array<[number, NodeJS.Signals | number | undefined]> = [];
    let groupAlive = true;
    const kill = jest.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0) {
        if (groupAlive) return true;
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      signals.push([pid, signal]);
      return true;
    }) as typeof process.kill);
    try {
      // The shell exits on SIGTERM, but a descendant keeps the group alive.
      const child = Object.assign(createMockChildProcess(), { pid: 4242 });
      jest.mocked(spawn).mockReturnValue(child as never);
      const controller = new AbortController();
      let settled = false;
      const pending = runShellCommand({
        command: "stubborn",
        abortSignal: controller.signal,
        killGraceMs: 500,
      }).then((result) => {
        settled = true;
        return result;
      });
      controller.abort();
      child.emit("close", null, "SIGTERM");
      await jest.advanceTimersByTimeAsync(400);
      expect(signals).toEqual([[-4242, "SIGTERM"]]);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(200);
      expect(signals).toEqual([
        [-4242, "SIGTERM"],
        [-4242, "SIGKILL"],
      ]);
      expect(settled).toBe(false);

      groupAlive = false;
      await jest.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toMatchObject({ aborted: true });

      // A group that empties within the grace period is never sent SIGKILL.
      signals.length = 0;
      groupAlive = true;
      const quick = Object.assign(createMockChildProcess(), { pid: 4343 });
      jest.mocked(spawn).mockReturnValue(quick as never);
      const quickController = new AbortController();
      const quickPending = runShellCommand({
        command: "quick",
        abortSignal: quickController.signal,
        killGraceMs: 500,
      });
      quickController.abort();
      groupAlive = false;
      quick.emit("close", null, "SIGTERM");
      await jest.advanceTimersByTimeAsync(1000);
      await quickPending;
      expect(signals).toEqual([[-4343, "SIGTERM"]]);
    } finally {
      kill.mockRestore();
      jest.useRealTimers();
    }
  });
});
