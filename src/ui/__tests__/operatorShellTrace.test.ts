import { jest, describe, it, expect } from "@jest/globals";
import type { TraceEventInput } from "../../trace/types.js";

jest.unstable_mockModule("../../tools/runShellCommand.js", () => ({
  runShellCommand: jest.fn(),
}));
const { runShellCommand } = await import("../../tools/runShellCommand.js");
const { processBashCommand } = await import("../processBashCommand.js");

function fixture(full = false) {
  const events: TraceEventInput[] = [];
  const close = jest.fn();
  const captureMaterial = jest.fn<(value: unknown) => undefined>(
    () => undefined,
  );
  const createTraceRun = jest.fn(() => ({
    recorder: {
      identity: { sessionId: "session", runId: "shell" },
      captureLevel: full ? ("full" as const) : ("standard" as const),
      record: (event: TraceEventInput) => {
        events.push(event);
      },
      captureMaterial,
    },
    close,
  }));
  const ui = {
    error: jest.fn(),
    setMode: jest.fn(),
    status: jest.fn(),
    bashCommand: jest.fn(),
    bashOutput: jest.fn(),
    clearEphemeralSurfaces: jest.fn(),
  };
  return { events, close, captureMaterial, createTraceRun, ui };
}

describe("operator shell journal", () => {
  it.each([
    [{ exitCode: 0 }, "success"],
    [{ exitCode: 2 }, "nonzero_exit"],
    [{ exitCode: -1, aborted: true }, "cancelled"],
    [{ exitCode: -1, timedOut: true }, "timed_out"],
    [{ exitCode: -1, launchFailed: true }, "launch_failed"],
    [{ exitCode: -1, maxBufferExceeded: true }, "output_truncated"],
  ] as const)("records one terminal outcome for %j", async (flags, outcome) => {
    const f = fixture();
    jest.mocked(runShellCommand).mockResolvedValue({
      stdout: "private output",
      stderr: "",
      durationMs: 4,
      ...flags,
    });
    await processBashCommand("echo private", f.ui as never, {
      createTraceRun: f.createTraceRun,
      cwd: "/tmp",
    });
    expect(f.events.map((e) => e.type)).toEqual([
      "run_started",
      "tool_policy_decision",
      "run_closed",
    ]);
    expect(f.events[2]?.payload).toMatchObject({
      actor: "user",
      source: "operator_shell",
      outcome,
      stdoutLength: 14,
    });
    expect(JSON.stringify(f.events)).not.toContain("private");
    expect(f.captureMaterial).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.ui.bashOutput).toHaveBeenCalledWith(
      "private output",
      "",
      flags.exitCode,
    );
  });

  it("passes command and bounded result to full material capture", async () => {
    const f = fixture(true);
    jest.mocked(runShellCommand).mockResolvedValue({
      stdout: "bounded",
      stderr: "error",
      exitCode: 1,
      durationMs: 2,
    });
    await processBashCommand("echo token", f.ui as never, {
      createTraceRun: f.createTraceRun,
    });
    expect(f.captureMaterial.mock.calls).toEqual([
      [{ command: "echo token" }],
      [{ stdout: "bounded", stderr: "error" }],
    ]);
    expect(JSON.stringify(f.events)).not.toContain("echo token");
  });

  it("skips empty input and records denial before execution", async () => {
    const f = fixture();
    jest.mocked(runShellCommand).mockClear();
    await processBashCommand(" ", f.ui as never, {
      createTraceRun: f.createTraceRun,
    });
    expect(f.createTraceRun).not.toHaveBeenCalled();
    await processBashCommand("rm file", f.ui as never, {
      createTraceRun: f.createTraceRun,
      agentMode: "plan",
    });
    expect(runShellCommand).not.toHaveBeenCalled();
    expect(f.events[2]?.payload).toMatchObject({ outcome: "policy_denied" });
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("preserves thrown execution errors and cleanup when material or close fails", async () => {
    const f = fixture(true);
    f.captureMaterial.mockImplementation(() => {
      throw new Error("capture");
    });
    f.close.mockImplementation(() => {
      throw new Error("close");
    });
    const error = new Error("spawn");
    jest.mocked(runShellCommand).mockRejectedValue(error);
    await expect(
      processBashCommand("echo private", f.ui as never, {
        createTraceRun: f.createTraceRun,
      }),
    ).rejects.toBe(error);
    expect(f.events[2]?.payload).toMatchObject({ outcome: "launch_failed" });
    expect(f.ui.setMode).toHaveBeenLastCalledWith("awaitingInput");
  });

  it("executes despite allocation and record failures", async () => {
    const f = fixture();
    jest.mocked(runShellCommand).mockResolvedValue({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    });
    await processBashCommand("echo ok", f.ui as never, {
      createTraceRun: () => {
        throw new Error("open");
      },
    });
    const run = f.createTraceRun();
    run.recorder.record = () => {
      throw new Error("write");
    };
    await processBashCommand("echo ok", f.ui as never, {
      createTraceRun: () => run,
    });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.ui.bashOutput).toHaveBeenCalledTimes(2);
  });
});
