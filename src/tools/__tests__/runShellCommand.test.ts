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

    expect(result).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
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
    });
  });

  it("maps string execFile error codes to -1 with a useful stderr message", async () => {
    mockExecFileAsync.mockRejectedValue({
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
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

    await expect(resultPromise).resolves.toEqual({
      stdout: "abcd",
      stderr: MAXBUFFER_TRUNCATION_MESSAGE,
      exitCode: -1,
      maxBufferExceeded: true,
    });
    expect(child.kill).toHaveBeenCalled();
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
    expect(child.kill).toHaveBeenCalled();
  });
});
