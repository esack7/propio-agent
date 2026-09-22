import * as fs from "fs";
import * as path from "path";
import {
  isPidRunning,
  parseInProgressMarkerSessionId,
  readInProgressMarkerFile,
  listSessions,
} from "./sessionHistory.js";
import { isSafeSessionId } from "./sessionId.js";

export function listActiveInProgressSessionIds(
  sessionsDir: string,
): Set<string> {
  const active = new Set<string>();
  if (!fs.existsSync(sessionsDir)) {
    return active;
  }

  for (const file of fs.readdirSync(sessionsDir)) {
    const sessionId = parseInProgressMarkerSessionId(file);
    if (!sessionId) {
      continue;
    }

    const marker = readInProgressMarkerFile(sessionsDir, file);
    if (!marker || !isPidRunning(marker.pid)) {
      continue;
    }

    active.add(sessionId);
  }

  return active;
}

function buildAnchoredSessionIds(sessionsDir: string): Set<string> {
  const anchored = new Set<string>();
  for (const entry of listSessions(sessionsDir)) {
    if (entry.runtimeSessionId) {
      anchored.add(entry.runtimeSessionId);
    }
    if (entry.sessionId) {
      anchored.add(entry.sessionId);
    }
  }
  return anchored;
}

/** Retire inactive, age-expired recovery material before it can anchor data. */
function pruneRecoveryFiles(
  sessionsDir: string,
  retentionMs: number,
  activeSessionIds: ReadonlySet<string>,
): void {
  if (!fs.existsSync(sessionsDir)) return;
  for (const file of fs.readdirSync(sessionsDir)) {
    pruneOneRecoveryFile(sessionsDir, file, retentionMs, activeSessionIds);
  }
}

function pruneOneRecoveryFile(
  sessionsDir: string,
  file: string,
  retentionMs: number,
  activeSessionIds: ReadonlySet<string>,
): void {
  const match =
    /^recovery-(.+)\.(?:json|jsonl)$/.exec(file) ??
    /^recovery-(.+)\.(?:json|jsonl)\.[0-9a-f]{12}\.tmp$/.exec(file);
  const sessionId = match?.[1];
  if (!sessionId || !isSafeSessionId(sessionId)) return;
  if (activeSessionIds.has(sessionId)) return;
  const filePath = path.join(sessionsDir, file);
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isFile() && Date.now() - stat.mtimeMs > retentionMs) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Retention cleanup is best effort; never prevent session startup.
  }
}

interface PruneSessionStorageOptions {
  skipSessionIds?: Set<string>;
  removeEmptyDirs?: boolean;
}

function isEmptyDirectory(dirPath: string): boolean {
  return fs.readdirSync(dirPath).length === 0;
}

function shouldPruneStorageDir(params: {
  dirName: string;
  dirPath: string;
  anchoredIds: Set<string>;
  retentionMs: number;
  options?: PruneSessionStorageOptions;
}): boolean {
  const { dirName, dirPath, anchoredIds, retentionMs, options } = params;
  if (options?.skipSessionIds?.has(dirName)) {
    return false;
  }
  if (options?.removeEmptyDirs && isEmptyDirectory(dirPath)) {
    return true;
  }
  if (anchoredIds.has(dirName)) {
    return false;
  }

  const mtime = fs.statSync(dirPath).mtimeMs;
  return Date.now() - mtime > retentionMs;
}

function pruneSessionStorageTree(
  rootDir: string,
  anchoredIds: Set<string>,
  retentionMs: number,
  options?: PruneSessionStorageOptions,
): void {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  for (const dirName of fs.readdirSync(rootDir)) {
    const dirPath = path.join(rootDir, dirName);
    try {
      if (!fs.statSync(dirPath).isDirectory()) {
        continue;
      }
      if (
        shouldPruneStorageDir({
          dirName,
          dirPath,
          anchoredIds,
          retentionMs,
          options,
        })
      ) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch {
      continue;
    }
  }
}

function pruneTraceJournalTree(
  rootDir: string,
  retentionMs: number,
  activeSessionIds: Set<string>,
): void {
  if (!fs.existsSync(rootDir)) return;

  for (const sessionId of fs.readdirSync(rootDir)) {
    if (activeSessionIds.has(sessionId)) continue;
    try {
      pruneTraceJournalSession(path.join(rootDir, sessionId), retentionMs);
    } catch {
      continue;
    }
  }
}

function pruneTraceJournalSession(
  sessionDir: string,
  retentionMs: number,
): void {
  if (!fs.statSync(sessionDir).isDirectory()) return;

  for (const fileName of fs.readdirSync(sessionDir)) {
    if (!fileName.endsWith(".jsonl")) continue;
    const journalPath = path.join(sessionDir, fileName);
    const stat = fs.statSync(journalPath);
    if (stat.isFile() && Date.now() - stat.mtimeMs > retentionMs) {
      fs.rmSync(journalPath, { force: true });
    }
  }

  if (isEmptyDirectory(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

/** Prune stale per-session artifacts, scratchpads, and trace journals. */
export function pruneStaleSessionStorage(
  sessionsDir: string,
  retentionDays: number,
): void {
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const activeInProgress = listActiveInProgressSessionIds(sessionsDir);
  pruneRecoveryFiles(sessionsDir, retentionMs, activeInProgress);
  const anchoredIds = buildAnchoredSessionIds(sessionsDir);

  pruneSessionStorageTree(
    path.join(sessionsDir, "artifacts"),
    anchoredIds,
    retentionMs,
  );
  pruneSessionStorageTree(
    path.join(sessionsDir, "scratchpads"),
    anchoredIds,
    retentionMs,
    { skipSessionIds: activeInProgress, removeEmptyDirs: true },
  );
  pruneTraceJournalTree(
    path.join(sessionsDir, "traces"),
    retentionMs,
    activeInProgress,
  );
}
