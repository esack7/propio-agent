import * as fs from "node:fs";
import * as path from "node:path";
import { isSafeSessionId } from "../sessions/sessionId.js";
import { readTraceSnapshot, type TraceSnapshot } from "./traceSnapshot.js";

export interface TraceRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly journalPath: string;
}

function validateTraceId(id: string): void {
  if (!isSafeSessionId(id))
    throw new Error(
      "Trace IDs must be safe single path components (1–128 characters)",
    );
}

function directoryEntries(directory: string): fs.Dirent[] {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Trace directory must be a real directory: ${directory}`);
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function discoverSession(
  root: string,
  sessionId: string,
): { runs: TraceRun[]; warnings: string[] } {
  const runs: TraceRun[] = [],
    warnings: string[] = [];
  for (const entry of directoryEntries(path.join(root, sessionId))) {
    if (!entry.name.endsWith(".jsonl")) continue;
    const runId = entry.name.slice(0, -6);
    if (!entry.isFile() || !isSafeSessionId(runId)) {
      warnings.push(`Skipped unsafe journal entry: ${sessionId}/${entry.name}`);
      continue;
    }
    runs.push({
      sessionId,
      runId,
      journalPath: path.join(root, sessionId, entry.name),
    });
  }
  return { runs, warnings };
}

/** Discovered symlinks are rejected, including links pointing within the root. */
export function discoverTraceRuns(
  root: string,
  sessionId?: string,
): { runs: TraceRun[]; warnings: string[] } {
  if (sessionId !== undefined) validateTraceId(sessionId);
  const runs: TraceRun[] = [];
  const warnings: string[] = [];
  for (const session of directoryEntries(root)) {
    if (sessionId !== undefined && session.name !== sessionId) continue;
    if (!session.isDirectory() || !isSafeSessionId(session.name)) {
      warnings.push(
        `Skipped unsafe or non-directory session entry: ${session.name}`,
      );
      continue;
    }
    try {
      const discovered = discoverSession(root, session.name);
      runs.push(...discovered.runs);
      warnings.push(...discovered.warnings);
    } catch {
      warnings.push(`Cannot read trace session: ${session.name}`);
    }
  }
  return { runs, warnings };
}

export function selectTraceRun(
  root: string,
  runId: string,
  sessionId?: string,
): TraceRun {
  validateTraceId(runId);
  const discovery = discoverTraceRuns(root, sessionId);
  const matches = discovery.runs.filter((run) => run.runId === runId);
  if (discovery.warnings.length)
    throw new Error(
      `Cannot safely select a run: ${discovery.warnings.join("; ")}`,
    );
  if (matches.length === 0) throw new Error(`Trace run not found: ${runId}`);
  if (matches.length > 1)
    throw new Error(`Ambiguous trace run: ${runId}; use --session <id>`);
  return matches[0];
}

export function readDiscoveredTrace(run: TraceRun): TraceSnapshot {
  // Recheck immediately before reading: entries may have changed during discovery.
  const root = fs.lstatSync(path.dirname(path.dirname(run.journalPath)));
  const parent = fs.lstatSync(path.dirname(run.journalPath));
  const stat = fs.lstatSync(run.journalPath);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    !stat.isFile() ||
    stat.isSymbolicLink()
  )
    throw new Error(
      "Trace journal is no longer a regular file in a real session directory",
    );
  return readTraceSnapshot(run.journalPath, run.sessionId, run.runId);
}
