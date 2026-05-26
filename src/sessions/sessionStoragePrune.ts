import * as fs from "fs";
import * as path from "path";
import { readIndex, rebuildIndex } from "./sessionHistory.js";

export function listActiveInProgressSessionIds(
  sessionsDir: string,
): Set<string> {
  const active = new Set<string>();
  if (!fs.existsSync(sessionsDir)) {
    return active;
  }

  for (const file of fs.readdirSync(sessionsDir)) {
    if (!file.startsWith("inprogress-") || !file.endsWith(".json")) {
      continue;
    }

    const sessionId = file.slice("inprogress-".length, -".json".length);
    try {
      const content = fs.readFileSync(path.join(sessionsDir, file), "utf8");
      const marker = JSON.parse(content) as { pid?: number };
      if (typeof marker.pid !== "number") {
        continue;
      }
      process.kill(marker.pid, 0);
      active.add(sessionId);
    } catch {
      // Malformed marker or process not running
    }
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

function pruneSessionStorageTree(
  rootDir: string,
  anchoredIds: Set<string>,
  retentionMs: number,
  skipSessionIds?: Set<string>,
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
      if (anchoredIds.has(dirName)) {
        continue;
      }
      if (skipSessionIds?.has(dirName)) {
        continue;
      }
      const mtime = fs.statSync(dirPath).mtimeMs;
      if (Date.now() - mtime > retentionMs) {
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
    activeInProgress,
  );
}
