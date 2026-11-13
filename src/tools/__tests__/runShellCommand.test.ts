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

  it("escalates to SIGKILL only while the command is still open", async () => {
    jest.useFakeTimers();
    try {
      const stubborn = createMockChildProcess();
      jest.mocked(spawn).mockReturnValue(stubborn as never);
      const stubbornController = new AbortController();
      const stubbornResult = runShellCommand({
        command: "stubborn",
        abortSignal: stubbornController.signal,
        killGraceMs: 500,
      });
      stubbornController.abort();
      jest.advanceTimersByTime(499);
      expect(stubborn.kill).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(stubborn.kill).toHaveBeenLastCalledWith("SIGKILL");
      stubborn.emit("close", null);
      await stubbornResult;

      const prompt = createMockChildProcess();
      jest.mocked(spawn).mockReturnValue(prompt as never);
      const promptController = new AbortController();
      const promptResult = runShellCommand({
        command: "prompt",
        abortSignal: promptController.signal,
        killGraceMs: 500,
      });
      promptController.abort();
      prompt.emit("close", null);
      await promptResult;
      jest.advanceTimersByTime(1000);
      expect(prompt.kill).toHaveBeenCalledTimes(1);
      expect(prompt.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      jest.useRealTimers();
    }
  });
});
