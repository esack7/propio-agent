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
      "operator_shell_started",
      "tool_policy_decision",
      `operator_shell_${outcome === "success" ? "completed" : outcome === "cancelled" ? "cancelled" : "failed"}`,
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

// These tests use the production recorder, redaction, inspection and export path.
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const {
  JsonlTraceJournal,
  RunTraceRecorder,
  exportTraceJournal,
  verifyTraceExport,
} = await import("../../trace/index.js");
const { inspectSessionUsage } = await import("../../cli/sessionInspection.js");
const { runTraceCommand } = await import("../../cli/traceCommand.js");

function expectShellTraceOutput(directory: string, sessionId: string): void {
  for (const json of [false, true]) {
    let output = "";
    expect(
      runTraceCommand(
        ["show", "shell", "--session", sessionId, ...(json ? ["--json"] : [])],
        {
          sessionsDir: directory,
          stdout: (text: string) => {
            output += text;
          },
          stderr: () => {},
        },
      ),
    ).toBe(0);
    expect(output).toContain("operator_shell");
    expect(output).toContain("stdoutLength");
    expect(output).toContain("exitCode");
    if (json) {
      const shown = JSON.parse(output);
      expect(shown.timeline.at(-1).durationMs).toEqual(expect.any(Number));
      expect(shown.timeline[0].metadata.cwd).toBe("nested");
    } else expect(output).toContain("decision=allowed");
  }
}

function expectFullShellMaterial(
  manifest: ReturnType<typeof exportTraceJournal>,
  destination: string,
): void {
  expect(
    manifest.material
      .filter(
        (entry) =>
          entry.kind === "tool_arguments" || entry.kind === "tool_result",
      )
      .map((entry) => entry.status),
  ).toEqual(["included", "included"]);
  const materialFiles = manifest.files.filter(
    (file) => file.path !== "events.jsonl",
  );
  expect(materialFiles).toHaveLength(2);
  for (const file of materialFiles)
    expect(fs.existsSync(path.join(destination, file.path))).toBe(true);
}

function expectStandardShellOmission(journalPath: string, destination: string) {
  const manifest = exportTraceJournal(journalPath, destination);
  expect(verifyTraceExport(destination)).toEqual([]);
  expect(manifest.files.map((file) => file.path)).toEqual(["events.jsonl"]);
  expect(manifest.material).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "tool_arguments", status: "omitted" }),
      expect.objectContaining({ kind: "tool_result", status: "omitted" }),
    ]),
  );
  const contents = fs.readFileSync(
    path.join(destination, "events.jsonl"),
    "utf8",
  );
  expect(contents).not.toMatch(
    /"material":|\.materials\/|echo private|private output/,
  );
}

it.each(["standard", "full"] as const)(
  "persists inspectable %s shell runs and exports private material only explicitly",
  async (captureLevel) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "operator-journal-"),
    );
    const root = path.join(directory, "traces");
    const sessionId = "session";
    const journalPath = path.join(root, sessionId, "shell.jsonl");
    try {
      const foreground = new JsonlTraceJournal(
        path.join(root, sessionId, "foreground.jsonl"),
      );
      const recorder = new RunTraceRecorder(
        { sessionId, runId: "foreground", operationId: "turn" },
        foreground,
      );
      recorder.record({
        component: "agent",
        type: "turn_started",
        payload: {},
      });
      const base = {
        version: 1,
        provider: "fixture",
        requestedModel: "model",
        trace: { requestId: "request", purpose: "answer" },
        attemptId: "attempt",
        attemptNumber: 1,
      };
      for (const type of [
        "provider_attempt_started",
        "provider_usage_reported",
        "provider_attempt_completed",
      ]) {
        recorder.record({
          component: "provider",
          type,
          payload: {
            ...base,
            type,
            availability: "reported",
            usage: { inputTokens: 10, outputTokens: 2 },
            reportKind: "cumulative",
          },
        });
      }
      recorder.record({
        component: "agent",
        type: "turn_completed",
        payload: {},
      });
      foreground.close();
      const before = inspectSessionUsage(root, sessionId).measurements.usage;
      const journal = new JsonlTraceJournal(journalPath, { captureLevel });
      const f = fixture();
      jest.mocked(runShellCommand).mockResolvedValue({
        stdout: "private output",
        stderr: "",
        exitCode: 0,
        durationMs: 4,
      });
      await processBashCommand("echo private", f.ui as never, {
        cwd: path.join(directory, "nested"),
        workspaceRoot: directory,
        createTraceRun: () => ({
          recorder: new RunTraceRecorder(
            { sessionId, runId: "shell" },
            journal,
          ),
          close: () => journal.close(),
        }),
      });
      const usage = inspectSessionUsage(root, sessionId);
      expect(usage.warnings).toEqual([]);
      expect(before.completeness).toBe("complete");
      expect(usage.measurements.usage).toEqual(before);
      const shell = usage.runs.find((run) => run.runId === "shell")!;
      expect(shell.complete).toBe(true);
      expect(shell.events[0]?.payload).toMatchObject({
        cwd: "nested",
        source: "operator_shell",
      });
      expect(shell.events[1]).toMatchObject({
        component: "policy",
        payload: {
          decision: "allowed",
          actor: "application",
          source: "operator_shell",
        },
      });
      expect(shell.events.at(-1)?.payload).toMatchObject({ durationMs: 4 });
      expect(fs.readFileSync(journalPath, "utf8")).not.toContain(
        "private output",
      );
      expectShellTraceOutput(directory, sessionId);
      const destination = path.join(directory, "bundle");
      const manifest = exportTraceJournal(journalPath, destination, {
        captureLevel: "full",
      });
      expect(verifyTraceExport(destination)).toEqual([]);
      if (captureLevel === "full") {
        expectFullShellMaterial(manifest, destination);
        expectStandardShellOmission(
          journalPath,
          path.join(directory, "standard-bundle"),
        );
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each(["policy_denied", "cancelled"])(
  "persists one inspectable terminal for %s",
  async (outcome) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "operator-terminal-"),
    );
    try {
      const journalPath = path.join(
        directory,
        "traces",
        "session",
        "shell.jsonl",
      );
      const journal = new JsonlTraceJournal(journalPath);
      const f = fixture();
      jest.mocked(runShellCommand).mockClear();
      jest.mocked(runShellCommand).mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: -1,
        aborted: true,
        durationMs: 1,
      });
      await processBashCommand("rm file", f.ui as never, {
        agentMode: outcome === "policy_denied" ? "plan" : "execute",
        createTraceRun: () => ({
          recorder: new RunTraceRecorder(
            { sessionId: "session", runId: "shell" },
            journal,
          ),
          close: () => journal.close(),
        }),
      });
      const usage = inspectSessionUsage(
        path.join(directory, "traces"),
        "session",
      );
      expect(usage.warnings).toEqual([]);
      const events = usage.runs[0]!.events;
      expect(events).toHaveLength(3);
      expect(events.at(-1)?.payload).toMatchObject({ outcome });
      expect(events[1]?.payload).toMatchObject({
        decision: outcome === "policy_denied" ? "denied" : "allowed",
      });
      expect(runShellCommand).toHaveBeenCalledTimes(
        outcome === "policy_denied" ? 0 : 1,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each(["policy_denied", "launch_failed"] as const)(
  "full exports do not expect shell output for %s",
  async (outcome) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "operator-no-output-"),
    );
    try {
      const journalPath = path.join(directory, "shell.jsonl");
      const journal = new JsonlTraceJournal(journalPath, {
        captureLevel: "full",
      });
      const f = fixture();
      const error = new Error("spawn failed");
      jest.mocked(runShellCommand).mockRejectedValue(error);
      const command = processBashCommand("rm file", f.ui as never, {
        agentMode: outcome === "policy_denied" ? "plan" : "execute",
        cwd: path.join(directory, "outside"),
        workspaceRoot: path.join(directory, "workspace"),
        createTraceRun: () => ({
          recorder: new RunTraceRecorder(
            { sessionId: "session", runId: "shell" },
            journal,
          ),
          close: () => journal.close(),
        }),
      });
      if (outcome === "launch_failed")
        await expect(command).rejects.toBe(error);
      else await command;
      const destination = path.join(directory, "bundle");
      const manifest = exportTraceJournal(journalPath, destination, {
        captureLevel: "full",
      });
      expect(verifyTraceExport(destination)).toEqual([]);
      expect(manifest.material).toContainEqual(
        expect.objectContaining({ kind: "tool_arguments", status: "included" }),
      );
      expect(manifest.material).not.toContainEqual(
        expect.objectContaining({ kind: "tool_result" }),
      );
      expect(fs.readFileSync(journalPath, "utf8")).toContain(
        '"cwd":"[outside workspace]"',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
