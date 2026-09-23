import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withProviderTracing } from "@propio-ai/providers";
import {
  exportTraceJournal,
  inspectTraceExport,
  JsonlTraceJournal,
  readTraceJournal,
  RunTraceRecorder,
  verifyTraceExport,
  type TraceEventEnvelope,
  type TraceMaterialReference,
} from "../trace/index.js";
import { WorkspaceTraceCapture } from "../trace/workspace.js";
import {
  createMockTool,
  createTestAgent,
  ToolCallMockProvider,
  userSubmission,
} from "./testHelpers.js";

function readMaterial(root: string, ref: TraceMaterialReference): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, ref.path), "utf8"));
}

function materialRef(
  event: TraceEventEnvelope | undefined,
  key: string,
): TraceMaterialReference {
  const payload = event?.payload as Record<string, unknown> | undefined;
  const ref = payload?.[key] as TraceMaterialReference | undefined;
  expect(ref).toBeDefined();
  return ref!;
}

describe("private full trace capture", () => {
  it("exports requests, responses, tool material, and workspace changes for offline inspection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "propio-full-capture-"));
    try {
      const workspaceRoot = path.join(root, "workspace");
      const sessionsDir = path.join(root, "sessions");
      const exportRoot = path.join(root, "bundle");
      fs.mkdirSync(workspaceRoot);
      fs.writeFileSync(path.join(workspaceRoot, "input.txt"), "before");
      let journalPath = "";
      const agent = createTestAgent(
        withProviderTracing(
          new ToolCallMockProvider("fixture_tool", {
            query: "needle",
            apiKey: "synthetic-secret",
          }),
        ),
        {
          sessionsDir,
          createTraceRun: (identity) => {
            journalPath = path.join(
              sessionsDir,
              "traces",
              identity.sessionId,
              `${identity.runId}.jsonl`,
            );
            const journal = new JsonlTraceJournal(journalPath, {
              captureLevel: "full",
            });
            const recorder = new RunTraceRecorder(identity, journal);
            const workspace = new WorkspaceTraceCapture(
              workspaceRoot,
              recorder,
            );
            return {
              recorder,
              captureWorkspace: (phase) => workspace.capture(phase),
              close: () => journal.close(),
            };
          },
        },
      );
      agent.addTool(
        createMockTool({
          name: "fixture_tool",
          execute: async () => {
            fs.writeFileSync(path.join(workspaceRoot, "output.txt"), "after");
            return "full tool result";
          },
        }),
      );

      await agent.streamChat(userSubmission("Inspect the workspace"), () => {});
      const manifest = exportTraceJournal(journalPath, exportRoot, {
        captureLevel: "full",
      });
      expect(manifest.version).toBe(4);
      expect(
        manifest.material.filter((entry) => entry.status !== "included"),
      ).toEqual([]);
      expect(
        manifest.operations.filter((entry) => entry.outcome === "unknown"),
      ).toEqual([]);
      expect(manifest.captureComplete).toBe(true);
      expect(verifyTraceExport(exportRoot)).toEqual([]);

      const events = readTraceJournal(
        path.join(exportRoot, "events.jsonl"),
      ).events;
      const request = events.find(
        (event) => event.type === "provider_request_dispatched",
      );
      const response = events.find(
        (event) => event.type === "provider_response_captured",
      );
      const start = events.find(
        (event) => event.type === "tool_execution_started",
      );
      const result = events.find(
        (event) => event.type === "tool_execution_completed",
      );
      const baseline = events.find(
        (event) => event.type === "workspace_baseline_captured",
      );
      const diff = events.find(
        (event) => event.type === "workspace_diff_captured",
      );
      expect(
        readMaterial(exportRoot, materialRef(request, "requestMaterial")),
      ).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: "Inspect the workspace",
          }),
        ]),
      });
      expect(
        readMaterial(exportRoot, materialRef(response, "responseMaterial")),
      ).toMatchObject({
        completed: true,
        events: expect.any(Array),
      });
      expect(
        readMaterial(exportRoot, materialRef(start, "argumentMaterial")),
      ).toEqual({
        query: "needle",
        apiKey: "[REDACTED]",
      });
      expect(
        readMaterial(exportRoot, materialRef(result, "resultMaterial")),
      ).toMatchObject({
        result: "full tool result",
      });
      const baselineValue = readMaterial(
        exportRoot,
        materialRef(baseline, "material"),
      ) as {
        files: Array<{ path: string; material: TraceMaterialReference }>;
      };
      expect(
        fs.readFileSync(
          path.join(
            exportRoot,
            baselineValue.files.find((file) => file.path === "input.txt")!
              .material.path,
          ),
          "utf8",
        ),
      ).toBe("before");
      const diffValue = readMaterial(
        exportRoot,
        materialRef(diff, "material"),
      ) as {
        changes: Array<{
          path: string;
          change: string;
          file: { material: TraceMaterialReference };
        }>;
      };
      expect(diffValue.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "output.txt", change: "added" }),
        ]),
      );
      expect(
        fs.readFileSync(
          path.join(
            exportRoot,
            diffValue.changes.find((change) => change.path === "output.txt")!
              .file.material.path,
          ),
          "utf8",
        ),
      ).toBe("after");
      expect(
        fs.readFileSync(path.join(exportRoot, "events.jsonl"), "utf8"),
      ).not.toContain("synthetic-secret");

      const standardRoot = path.join(root, "standard-bundle");
      const standard = exportTraceJournal(journalPath, standardRoot);
      expect(standard.version).toBe(3);
      expect(standard.files.map((file) => file.path)).toEqual(["events.jsonl"]);
      expect(verifyTraceExport(standardRoot)).toEqual([]);
      const standardEvents = readTraceJournal(
        path.join(standardRoot, "events.jsonl"),
      ).events;
      expect(
        (
          standardEvents.find(
            (event) => event.type === "provider_request_dispatched",
          )?.payload as Record<string, unknown>
        )?.requestMaterial,
      ).toBeUndefined();

      fs.renameSync(sessionsDir, path.join(root, "removed-source"));
      expect(inspectTraceExport(exportRoot).manifest.version).toBe(4);
      fs.appendFileSync(
        path.join(
          exportRoot,
          diffValue.changes.find((change) => change.path === "output.txt")!.file
            .material.path,
        ),
        "tampered",
      );
      expect(verifyTraceExport(exportRoot)).toEqual(
        expect.arrayContaining([expect.stringContaining("mismatch")]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks omitted credential files and missing private material as incomplete", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "propio-full-omissions-"),
    );
    try {
      const workspaceRoot = path.join(root, "workspace");
      const journalPath = path.join(root, "source", "run.jsonl");
      const exportRoot = path.join(root, "bundle");
      fs.mkdirSync(workspaceRoot);
      fs.writeFileSync(path.join(workspaceRoot, ".env"), "API_KEY=hidden");
      fs.writeFileSync(path.join(workspaceRoot, "safe.txt"), "visible");
      const journal = new JsonlTraceJournal(journalPath, {
        captureLevel: "full",
      });
      const recorder = new RunTraceRecorder(
        { sessionId: "session-1", runId: "run" },
        journal,
      );
      const workspace = new WorkspaceTraceCapture(workspaceRoot, recorder);
      workspace.capture("baseline");
      workspace.capture("final");
      journal.close();

      const manifest = exportTraceJournal(journalPath, exportRoot, {
        captureLevel: "full",
      });
      expect(manifest.captureComplete).toBe(false);
      expect(manifest.material).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "workspace_baseline",
            status: "partial",
          }),
        ]),
      );
      expect(verifyTraceExport(exportRoot)).toEqual([]);
      expect(
        fs.readFileSync(path.join(exportRoot, "events.jsonl"), "utf8"),
      ).not.toContain("API_KEY=hidden");

      const event = readTraceJournal(path.join(exportRoot, "events.jsonl"))
        .events[0];
      const snapshot = readMaterial(
        exportRoot,
        materialRef(event, "material"),
      ) as {
        files: Array<{ path: string; omittedReason?: string }>;
      };
      expect(snapshot.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ".env",
            omittedReason: "sensitive_path",
          }),
        ]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a lost captured result in the full export manifest", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "propio-lost-material-"),
    );
    try {
      const journalPath = path.join(root, "run.jsonl");
      const journal = new JsonlTraceJournal(journalPath, {
        captureLevel: "full",
      });
      const recorder = new RunTraceRecorder(
        { sessionId: "session-1", runId: "run" },
        journal,
      );
      const resultMaterial = recorder.captureMaterial({ result: "completed" })!;
      recorder.record(
        {
          component: "tool",
          type: "tool_execution_completed",
          identity: { toolCallId: "call-1" },
          payload: { resultMaterial },
        },
        { durable: true },
      );
      journal.close();
      fs.unlinkSync(path.join(root, resultMaterial.path));

      const bundle = path.join(root, "bundle");
      const manifest = exportTraceJournal(journalPath, bundle, {
        captureLevel: "full",
      });
      expect(manifest.material).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "tool_result", status: "missing" }),
        ]),
      );
      expect(manifest.captureComplete).toBe(false);
      expect(verifyTraceExport(bundle)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records deletion of a Git-tracked workspace file without an omission", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "propio-git-delete-"));
    try {
      const workspaceRoot = path.join(root, "workspace");
      const journalPath = path.join(root, "source", "run.jsonl");
      const exportRoot = path.join(root, "bundle");
      fs.mkdirSync(workspaceRoot);
      fs.writeFileSync(path.join(workspaceRoot, "tracked.txt"), "before");
      execFileSync("git", ["init", "-q"], { cwd: workspaceRoot });
      execFileSync("git", ["add", "tracked.txt"], { cwd: workspaceRoot });
      const journal = new JsonlTraceJournal(journalPath, {
        captureLevel: "full",
      });
      const recorder = new RunTraceRecorder(
        { sessionId: "session-1", runId: "run" },
        journal,
      );
      const workspace = new WorkspaceTraceCapture(workspaceRoot, recorder);
      workspace.capture("baseline");
      fs.unlinkSync(path.join(workspaceRoot, "tracked.txt"));
      workspace.capture("checkpoint");
      journal.close();

      const manifest = exportTraceJournal(journalPath, exportRoot, {
        captureLevel: "full",
      });
      const diff = readTraceJournal(
        path.join(exportRoot, "events.jsonl"),
      ).events.find((event) => event.type === "workspace_diff_captured");
      expect(diff?.payload).toMatchObject({ omissionCount: 0 });
      expect(
        readMaterial(exportRoot, materialRef(diff, "material")),
      ).toMatchObject({
        changes: [{ path: "tracked.txt", change: "deleted" }],
      });
      expect(manifest.captureComplete).toBe(true);
      expect(verifyTraceExport(exportRoot)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["run_1.jsonl", "trace.log"])(
    "exports full material from a %s journal",
    (journalName) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "propio-journal-name-"),
      );
      try {
        const journalPath = path.join(root, journalName);
        const journal = new JsonlTraceJournal(journalPath, {
          captureLevel: "full",
        });
        const recorder = new RunTraceRecorder(
          { sessionId: "session-1", runId: "run" },
          journal,
        );
        const resultMaterial = recorder.captureMaterial({ result: "present" });
        recorder.record({
          component: "tool",
          type: "tool_execution_completed",
          payload: { resultMaterial },
        });
        journal.close();

        const exportRoot = path.join(root, "bundle");
        const manifest = exportTraceJournal(journalPath, exportRoot, {
          captureLevel: "full",
        });
        expect(manifest.material).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "tool_result",
              status: "included",
            }),
          ]),
        );
        expect(verifyTraceExport(exportRoot)).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("does not traverse or copy material referenced from a sibling run", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "propio-run-scope-"));
    try {
      const sourceRoot = path.join(root, "source");
      const other = new JsonlTraceJournal(
        path.join(sourceRoot, "run_b.jsonl"),
        { captureLevel: "full" },
      );
      const nested = other.captureMaterial({ note: "nested-other-run" })!;
      const foreign = other.captureMaterial({ nested })!;
      other.close();

      const journalPath = path.join(sourceRoot, "run_a.jsonl");
      const journal = new JsonlTraceJournal(journalPath, {
        captureLevel: "full",
      });
      const recorder = new RunTraceRecorder(
        { sessionId: "session-1", runId: "run_a" },
        journal,
      );
      const own = recorder.captureMaterial({ result: { foreign } })!;
      recorder.record(
        {
          component: "tool",
          type: "tool_execution_completed",
          payload: { resultMaterial: own },
        },
        { durable: true },
      );
      journal.close();

      const exportRoot = path.join(root, "bundle");
      const manifest = exportTraceJournal(journalPath, exportRoot, {
        captureLevel: "full",
      });
      expect(manifest.version).toBe(4);
      if (manifest.version !== 4) throw new Error("Expected full export");
      expect(manifest.materialDirectory).toBe("run_a.materials");
      expect(manifest.files.map((file) => file.path)).toContain(own.path);
      expect(manifest.files.map((file) => file.path)).not.toContain(
        foreign.path,
      );
      expect(manifest.files.map((file) => file.path)).not.toContain(
        nested.path,
      );
      expect(manifest.material).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "missing",
            reason: "material_outside_source_run",
            referenceId: foreign.sha256,
          }),
        ]),
      );
      expect(manifest.material).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ referenceId: nested.sha256 }),
        ]),
      );
      expect(manifest.captureComplete).toBe(false);
      expect(verifyTraceExport(exportRoot)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores nested Buffers as compact base64 material", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "propio-buffer-image-"));
    try {
      const journal = new JsonlTraceJournal(path.join(root, "run.jsonl"), {
        captureLevel: "full",
      });
      const image = Buffer.from([0, 255, 1, 128]);
      const bytes = new Uint8Array([2, 3, 4]);
      const ref = journal.captureMaterial({ messages: [{ image, bytes }] })!;
      expect(readMaterial(root, ref)).toEqual({
        messages: [
          {
            image: { $binary: image.toString("base64") },
            bytes: { $binary: Buffer.from(bytes).toString("base64") },
          },
        ],
      });
      journal.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink at a content-addressed material path", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "propio-material-link-"),
    );
    try {
      const journal = new JsonlTraceJournal(path.join(root, "run.jsonl"), {
        captureLevel: "full",
      });
      const value = { result: "private" };
      const ref = journal.captureMaterial(value)!;
      const materialPath = path.join(root, ref.path);
      const outsidePath = path.join(root, "outside.txt");
      fs.writeFileSync(outsidePath, "untouched");
      fs.unlinkSync(materialPath);
      fs.symlinkSync(outsidePath, materialPath);

      expect(journal.captureMaterial(value)).toBeUndefined();
      expect(journal.captureDegraded).toBe(true);
      expect(fs.readFileSync(outsidePath, "utf8")).toBe("untouched");
      journal.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
