import * as fs from "fs";
import * as path from "path";
import {
  isPidRunning,
  parseInProgressMarkerSessionId,
  readInProgressMarkerFile,
  readIndex,
  rebuildIndex,
} from "./sessionHistory.js";

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
  const index = readIndex(sessionsDir) ?? rebuildIndex(sessionsDir);
  const anchored = new Set<string>();
  for (const entry of index.entries) {
    if (entry.runtimeSessionId) {
      anchored.add(entry.runtimeSessionId);
    }
    if (entry.sessionId) {
      anchored.add(entry.sessionId);
    }
  }
  return anchored;
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

/** Prune stale per-session artifact and scratchpad directories under sessionsDir. */
export function pruneStaleSessionStorage(
  sessionsDir: string,
  retentionDays: number,
): void {
  const anchoredIds = buildAnchoredSessionIds(sessionsDir);
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const activeInProgress = listActiveInProgressSessionIds(sessionsDir);

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
}
