import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readSnapshot,
  resolveLatestSession,
  resolveLatestRecoveryCheckpoint,
} from "../sessions/sessionHistory.js";
import {
  exportTraceJournal,
  inspectTraceExport,
  readTraceJournal,
} from "../trace/index.js";

const childScript = fileURLToPath(
  new URL("./fixtures/recoveryChild.mjs", import.meta.url),
);

function runChild(
  mode: "run" | "run-full" | "resume" | "failure",
  sessionsDir: string,
  stopAtSecondTool = false,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", childScript, mode, sessionsDir],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Recovery child timed out: ${output}\n${errors}`));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (stopAtSecondTool && output.includes("SECOND_STARTED")) {
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (!stopAtSecondTool && code !== 0) {
        reject(new Error(`Recovery child failed: ${errors || output}`));
      } else if (stopAtSecondTool && signal !== "SIGKILL") {
        reject(new Error(`Expected hard stop: ${errors || output}`));
      } else {
        resolve({ code, signal });
      }
    });
  });
}

describe("failed-run recovery across process restart", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-recovery-"));
    sessionsDir = path.join(tempDir, "sessions");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps the first result, marks missing responses unresolved, and never replays tools", async () => {
    await runChild("run", sessionsDir, true);
    expect(
      fs.readFileSync(path.join(sessionsDir, "tool-calls.txt"), "utf8"),
    ).toBe("first\nsecond\n");

    const checkpoint = resolveLatestRecoveryCheckpoint(sessionsDir);
    expect(checkpoint?.recoveryCheckpoint).toBe(true);
    const persisted = JSON.parse(
      readSnapshot(sessionsDir, checkpoint!.snapshotFile),
    );
    expect(persisted.context.artifacts).toEqual([
      expect.objectContaining({ content: "first completed" }),
    ]);
    const sessionId = persisted.metadata.sessionId as string;
    const interruptedRunId = persisted.metadata.lastTraceRunId as string;
    const journalPath = path.join(
      sessionsDir,
      "traces",
      sessionId,
      `${interruptedRunId}.jsonl`,
    );
    const journal = readTraceJournal(journalPath);
    expect(
      journal.events.filter(
        (event) => event.type === "tool_execution_completed",
      ),
    ).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({ toolCallId: "call-1" }),
      }),
    ]);
    expect(
      journal.events
        .filter((event) => event.type === "tool_execution_started")
        .map((event) => event.identity.toolCallId),
    ).toEqual(["call-1", "call-2"]);

    fs.appendFileSync(journalPath, '{"version":');
    const exportDirectory = path.join(tempDir, "portable-export");
    exportTraceJournal(journalPath, exportDirectory);
    const offlineSource = path.join(tempDir, "offline-source");
    fs.renameSync(sessionsDir, offlineSource);
    let inspected;
    try {
      inspected = inspectTraceExport(exportDirectory);
    } finally {
      fs.renameSync(offlineSource, sessionsDir);
    }
    expect(inspected.warnings).toEqual([
      expect.objectContaining({ type: "truncated_final_line" }),
    ]);

    await runChild("resume", sessionsDir);
    expect(
      fs.readFileSync(path.join(sessionsDir, "tool-calls.txt"), "utf8"),
    ).toBe("first\nsecond\n");
    const requests = JSON.parse(
      fs.readFileSync(path.join(sessionsDir, "resumed-requests.json"), "utf8"),
    ) as Array<{
      role: string;
      toolResults?: Array<{ toolCallId: string; content: string }>;
    }>;
    const results = requests.flatMap((message) => message.toolResults ?? []);
    expect(results.map((result) => result.toolCallId)).toEqual([
      "call-1",
      "call-2",
      "call-3",
    ]);
    expect(results[0]?.content).toBe("first completed");
    expect(results[1]?.content).toContain("Completion is unknown");

    const resumedRunId = fs
      .readdirSync(path.join(sessionsDir, "traces", sessionId))
      .map((file) => path.basename(file, ".jsonl"))
      .find((runId) => runId !== interruptedRunId);
    expect(resumedRunId).toBeDefined();
    const resumedJournal = readTraceJournal(
      path.join(sessionsDir, "traces", sessionId, `${resumedRunId}.jsonl`),
    );
    expect(resumedJournal.events).toContainEqual(
      expect.objectContaining({
        type: "run_started",
        payload: expect.objectContaining({ previousRunId: interruptedRunId }),
      }),
    );
    expect(
      resumedJournal.events
        .filter((event) => event.type === "recovered_tool_call_unresolved")
        .map((event) => event.identity.toolCallId),
    ).toEqual(["call-2", "call-3"]);
  }, 30_000);

  it("keeps the tool outcome visible when checkpoint storage fails", async () => {
    await runChild("failure", sessionsDir);
    expect(
      fs.readFileSync(path.join(sessionsDir, "tool-calls.txt"), "utf8"),
    ).toBe("first\n");
    expect(
      fs.readFileSync(
        path.join(sessionsDir, "checkpoint-failures.txt"),
        "utf8",
      ),
    ).toContain("checkpoint storage unavailable");
    expect(resolveLatestSession(sessionsDir)).toBeNull();

    const tracesRoot = path.join(sessionsDir, "traces");
    const sessionId = fs.readdirSync(tracesRoot)[0];
    const runFile = fs.readdirSync(path.join(tracesRoot, sessionId))[0];
    const events = readTraceJournal(
      path.join(tracesRoot, sessionId, runFile),
    ).events;
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "tool_execution_completed",
        "recovery_checkpoint_failed",
        "run_closed",
      ]),
    );
  }, 30_000);

  it("exports the last completed workspace change after a hard stop", async () => {
    await runChild("run-full", sessionsDir, true);
    const checkpoint = resolveLatestRecoveryCheckpoint(sessionsDir);
    const snapshot = JSON.parse(
      readSnapshot(sessionsDir, checkpoint!.snapshotFile),
    );
    const sessionId = snapshot.metadata.sessionId as string;
    const runId = snapshot.metadata.lastTraceRunId as string;
    const journalPath = path.join(
      sessionsDir,
      "traces",
      sessionId,
      `${runId}.jsonl`,
    );
    const exportDirectory = path.join(tempDir, "full-export");
    const manifest = exportTraceJournal(journalPath, exportDirectory, {
      captureLevel: "full",
    });
    expect(manifest.version).toBe(4);
    expect(manifest.captureComplete).toBe(false);
    expect(manifest.material).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "workspace_baseline",
          status: "included",
        }),
        expect.objectContaining({ kind: "workspace_diff", status: "included" }),
        expect.objectContaining({ kind: "tool_result", status: "included" }),
      ]),
    );
    const diffEvent = readTraceJournal(
      path.join(exportDirectory, "events.jsonl"),
    ).events.find((event) => event.type === "workspace_diff_captured");
    const diffRef = (diffEvent?.payload as { material: { path: string } })
      .material;
    const diff = JSON.parse(
      fs.readFileSync(path.join(exportDirectory, diffRef.path), "utf8"),
    ) as {
      changes: Array<{ path: string; file: { material: { path: string } } }>;
    };
    const changed = diff.changes.find((change) => change.path === "after.txt");
    expect(changed).toBeDefined();
    expect(
      fs.readFileSync(
        path.join(exportDirectory, changed!.file.material.path),
        "utf8",
      ),
    ).toBe("after");
    fs.renameSync(sessionsDir, path.join(tempDir, "removed-sessions"));
    expect(inspectTraceExport(exportDirectory).manifest.version).toBe(4);
  }, 30_000);
});
