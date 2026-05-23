import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../../tools/runShellCommand.js", () => ({
  runShellCommand: jest.fn(),
}));

const { runShellCommand } = await import("../../tools/runShellCommand.js");
const { processBashCommand } = await import("../processBashCommand.js");

describe("processBashCommand", () => {
  beforeEach(() => {
    jest.mocked(runShellCommand).mockReset();
  });

  it("skips empty commands", async () => {
    const ui = {
      setMode: jest.fn(),
      status: jest.fn(),
      bashCommand: jest.fn(),
      bashOutput: jest.fn(),
      clearEphemeralSurfaces: jest.fn(),
    };

    await processBashCommand("   ", ui as never);

    expect(runShellCommand).not.toHaveBeenCalled();
    expect(ui.bashCommand).not.toHaveBeenCalled();
  });

  it("runs the command and renders output", async () => {
    jest.mocked(runShellCommand).mockResolvedValue({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
    });

    const ui = {
      setMode: jest.fn(),
      status: jest.fn(),
      bashCommand: jest.fn(),
      bashOutput: jest.fn(),
      clearEphemeralSurfaces: jest.fn(),
    };

    await processBashCommand("echo ok", ui as never, {
      cwd: "/tmp",
      timeoutMs: 5000,
      maxBuffer: 1024,
    });

    expect(ui.setMode).toHaveBeenNthCalledWith(1, "running");
    expect(ui.bashCommand).toHaveBeenCalledWith("echo ok");
    expect(runShellCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "echo ok",
        cwd: "/tmp",
        timeoutMs: 5000,
        maxBuffer: 1024,
      }),
    );
    expect(ui.bashOutput).toHaveBeenCalledWith("ok\n", "", 0);
    expect(ui.setMode).toHaveBeenLastCalledWith("awaitingInput");
  });

  it("passes abort signals through to the shell runner", async () => {
    const controller = new AbortController();
    jest.mocked(runShellCommand).mockResolvedValue({
      stdout: "",
      stderr: "Command cancelled",
      exitCode: -1,
      aborted: true,
    });

    const ui = {
      setMode: jest.fn(),
      status: jest.fn(),
      bashCommand: jest.fn(),
      bashOutput: jest.fn(),
      clearEphemeralSurfaces: jest.fn(),
    };

    await processBashCommand("sleep 10", ui as never, {
      abortSignal: controller.signal,
    });

    expect(runShellCommand).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal }),
    );
    expect(ui.bashOutput).toHaveBeenCalledWith("", "Command cancelled", -1);
  });
});
