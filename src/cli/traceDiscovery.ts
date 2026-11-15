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

function matchSessionRun(
  root: string,
  sessionId: string,
  runId: string,
): TraceRun | undefined {
  const journalPath = path.join(root, sessionId, `${runId}.jsonl`);
  const stat = fs.lstatSync(journalPath, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Cannot safely select run: ${sessionId}/${runId}`);
  return { sessionId, runId, journalPath };
}

function isSearchableSession(session: fs.Dirent, sessionId?: string): boolean {
  if (sessionId !== undefined && session.name !== sessionId) return false;
  if (!isSafeSessionId(session.name)) return false;
  if (session.isSymbolicLink() && sessionId !== undefined)
    throw new Error(
      `Cannot safely select a run: linked session ${session.name}`,
    );
  return session.isDirectory() && !session.isSymbolicLink();
}

export function selectTraceRun(
  root: string,
  runId: string,
  sessionId?: string,
): TraceRun {
  validateTraceId(runId);
  if (sessionId !== undefined) validateTraceId(sessionId);
  const matches: TraceRun[] = [];
  for (const session of directoryEntries(root)) {
    if (!isSearchableSession(session, sessionId)) continue;
    const match = matchSessionRun(root, session.name, runId);
    if (match) matches.push(match);
  }
  if (matches.length === 0) throw new Error(`Trace run not found: ${runId}`);
  if (matches.length > 1)
    throw new Error(`Ambiguous trace run: ${runId}; use --session <id>`);
  return matches[0];
}

function withTraceFile<T>(run: TraceRun, read: (fd: number) => T): T {
  const rootPath = path.dirname(path.dirname(run.journalPath));
  const parentPath = path.dirname(run.journalPath);
  const directories = [rootPath, parentPath];
  checkTraceDirectories(directories);
  const fd = fs.openSync(
    run.journalPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    checkTraceDirectories(directories);
    return readCheckedFile(run, fd, read);
  } finally {
    fs.closeSync(fd);
  }
}

function checkTraceDirectories(directories: string[]): void {
  for (const directory of directories) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Trace directory changed during discovery");
  }
}

function readCheckedFile<T>(
  run: TraceRun,
  fd: number,
  read: (fd: number) => T,
): T {
  const rootPath = path.dirname(path.dirname(run.journalPath));
  const parentPath = path.dirname(run.journalPath);
  const stat = fs.fstatSync(fd);
  const current = fs.lstatSync(run.journalPath);
  if (
    !stat.isFile() ||
    current.isSymbolicLink() ||
    stat.ino !== current.ino ||
    stat.dev !== current.dev ||
    fs.realpathSync(parentPath) !==
      path.join(fs.realpathSync(rootPath), run.sessionId)
  )
    throw new Error("Trace journal changed during discovery");
  return read(fd);
}

export function readDiscoveredTrace(run: TraceRun): TraceSnapshot {
  return withTraceFile(run, (fd) =>
    readTraceSnapshot(fd, run.sessionId, run.runId),
  );
}

/** Bounded header probe: list ordering never scans whole unselected journals. */
export function traceRunObservedAt(run: TraceRun): string | null {
  return withTraceFile(run, (fd) => {
    const buffer = Buffer.alloc(64 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(10, 0);
    if (newline < 0 && length === buffer.length)
      throw new Error("Trace header exceeds 64 KiB");
    const first: unknown = JSON.parse(
      buffer.subarray(0, newline < 0 ? length : newline).toString("utf8"),
    );
    if (!first || typeof first !== "object")
      throw new Error("Invalid trace header");
    const observedAt = (first as { observedAt?: unknown }).observedAt;
    return typeof observedAt === "string" &&
      Number.isFinite(Date.parse(observedAt))
      ? observedAt
      : null;
  });
}
