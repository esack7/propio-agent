import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

// The benchmark script builds dist first; these modules do not exist at audit time.
const builtTraceRoot = new URL("../dist/trace/", import.meta.url);
const { JsonlTraceJournal, RunTraceRecorder } = await import(
  new URL("index.js", builtTraceRoot).href
);
const { WorkspaceTraceCapture } = await import(
  new URL("workspace.js", builtTraceRoot).href
);

const limits = {
  tokenCaptureMs: 1000,
  toolCaptureMs: 5000,
  workspaceCaptureMs: 5000,
  tokenBytes: 1_000_000,
  toolBytes: 2_000_000,
  workspaceBytes: 5_000_000,
};

function directoryBytes(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .reduce((sum, entry) => {
      const file = path.join(directory, entry.name);
      return (
        sum +
        (entry.isDirectory() ? directoryBytes(file) : fs.statSync(file).size)
      );
    }, 0);
}

function fixture(root, label, captureLevel) {
  const runDirectory = path.join(root, label);
  const journal = new JsonlTraceJournal(path.join(runDirectory, "run.jsonl"), {
    captureLevel,
  });
  const recorder = new RunTraceRecorder(
    { sessionId: "bench", runId: label },
    journal,
  );
  return { runDirectory, journal, recorder };
}

function measureTokenCapture(root, captureLevel) {
  const run = fixture(root, `tokens-${captureLevel}`, captureLevel);
  const events = Array.from({ length: 1000 }, (_, index) => ({
    type: "assistant_text",
    delta: `token-${index} `,
  }));
  const start = performance.now();
  const material =
    captureLevel === "full"
      ? run.recorder.captureMaterial({ events, completed: true })
      : undefined;
  run.recorder.record(
    {
      component: "agent",
      type: "provider_response_captured",
      payload: { responseMaterial: material },
    },
    { durable: true },
  );
  run.journal.close();
  return {
    ms: performance.now() - start,
    bytes: directoryBytes(run.runDirectory),
  };
}

function measureToolCapture(root, captureLevel) {
  const run = fixture(root, `tools-${captureLevel}`, captureLevel);
  const result = "r".repeat(4096);
  const start = performance.now();
  for (let index = 0; index < 100; index++) {
    const argumentMaterial =
      captureLevel === "full"
        ? run.recorder.captureMaterial({ index, path: `file-${index}.txt` })
        : undefined;
    const resultMaterial =
      captureLevel === "full"
        ? run.recorder.captureMaterial({ result: `${index}:${result}` })
        : undefined;
    run.recorder.record(
      {
        component: "tool",
        type: "tool_execution_completed",
        identity: { toolCallId: `call-${index}` },
        payload: { argumentMaterial, resultMaterial },
      },
      { durable: true },
    );
  }
  run.journal.close();
  return {
    ms: performance.now() - start,
    bytes: directoryBytes(run.runDirectory),
  };
}

function measureWorkspaceCapture(root) {
  const run = fixture(root, "workspace-trace", "full");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot);
  for (let index = 0; index < 100; index++) {
    fs.writeFileSync(
      path.join(workspaceRoot, `file-${index}.txt`),
      "x".repeat(2048),
    );
  }
  const capture = new WorkspaceTraceCapture(workspaceRoot, run.recorder);
  const start = performance.now();
  capture.capture("baseline");
  for (let index = 0; index < 20; index++) {
    fs.writeFileSync(
      path.join(workspaceRoot, "file-0.txt"),
      `changed-${index}`,
    );
    capture.capture("checkpoint");
  }
  run.journal.close();
  return {
    ms: performance.now() - start,
    bytes: directoryBytes(run.runDirectory),
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "propio-trace-bench-"));
try {
  const result = {
    standard: {
      tokenHeavy: measureTokenCapture(root, "standard"),
      toolHeavy: measureToolCapture(root, "standard"),
    },
    full: {
      tokenHeavy: measureTokenCapture(root, "full"),
      toolHeavy: measureToolCapture(root, "full"),
      workspace: measureWorkspaceCapture(root),
    },
  };
  const passed =
    result.full.tokenHeavy.ms <= limits.tokenCaptureMs &&
    result.full.toolHeavy.ms <= limits.toolCaptureMs &&
    result.full.workspace.ms <= limits.workspaceCaptureMs &&
    result.full.tokenHeavy.bytes <= limits.tokenBytes &&
    result.full.toolHeavy.bytes <= limits.toolBytes &&
    result.full.workspace.bytes <= limits.workspaceBytes;
  process.stdout.write(
    `${JSON.stringify({ result, limits, passed }, null, 2)}\n`,
  );
  if (!passed) process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
