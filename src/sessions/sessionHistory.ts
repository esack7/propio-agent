import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const DEFAULT_SESSIONS_DIR = ".propio/sessions";
const INDEX_FILE = "index.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionIndexEntry {
  readonly sessionId: string;
  readonly snapshotFile: string;
  readonly savedAt: string;
  readonly providerName: string;
  readonly modelKey: string;
  readonly turnCount: number;
  readonly hasRollingSummary: boolean;
}

export interface SessionIndex {
  readonly entries: ReadonlyArray<SessionIndexEntry>;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getDefaultSessionsDir(): string {
  return path.resolve(process.cwd(), DEFAULT_SESSIONS_DIR);
}

function indexPath(sessionsDir: string): string {
  return path.join(sessionsDir, INDEX_FILE);
}

function generateSnapshotFileName(): string {
  const timestamp = new Date().toISOString().replace(/:/g, "-");
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${timestamp}-${suffix}.json`;
}

// ---------------------------------------------------------------------------
// Index I/O
// ---------------------------------------------------------------------------

function isValidIndex(value: unknown): value is SessionIndex {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.entries);
}

export function readIndex(sessionsDir: string): SessionIndex | null {
  try {
    const content = fs.readFileSync(indexPath(sessionsDir), "utf8");
    const parsed: unknown = JSON.parse(content);
    if (isValidIndex(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeIndex(sessionsDir: string, index: SessionIndex): void {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    indexPath(sessionsDir),
    JSON.stringify(index, null, 2),
    "utf8",
  );
}

/**
 * Rebuild the index by scanning snapshot files in the sessions directory.
 * Parses just enough of each file to extract metadata for the index entry.
 * Writes the rebuilt index to disk and returns it.
 */
export function rebuildIndex(sessionsDir: string): SessionIndex {
  if (!fs.existsSync(sessionsDir)) {
    return { entries: [] };
  }

  const files = fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".json") && f !== INDEX_FILE)
    .sort();

  const entries: SessionIndexEntry[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(sessionsDir, file), "utf8");
      const parsed: unknown = JSON.parse(content);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        continue;
      }
      const obj = parsed as Record<string, unknown>;
      if (obj.version !== 1 && obj.version !== 2) continue;
      if (typeof obj.metadata !== "object" || obj.metadata === null) continue;
      if (typeof obj.context !== "object" || obj.context === null) continue;

      const meta = obj.metadata as Record<string, unknown>;
      const ctx = obj.context as Record<string, unknown>;

      entries.push({
        sessionId: path.basename(file, ".json"),
        snapshotFile: file,
        savedAt: typeof obj.savedAt === "string" ? obj.savedAt : "",
        providerName:
          typeof meta.providerName === "string" ? meta.providerName : "",
        modelKey: typeof meta.modelKey === "string" ? meta.modelKey : "",
        turnCount: Array.isArray(ctx.turns) ? ctx.turns.length : 0,
        hasRollingSummary: ctx.rollingSummary !== undefined,
      });
    } catch {
      // skip malformed files
    }
  }

  entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  const index: SessionIndex = { entries };
  writeIndex(sessionsDir, index);
  return index;
}

// ---------------------------------------------------------------------------
// Snapshot I/O
// ---------------------------------------------------------------------------

/**
 * Write a session snapshot to disk and update the index.
 * `sessionJson` should be the output of `Agent.exportSession()`.
 * Returns the index entry for the newly written snapshot.
 */
export function writeSnapshot(
  sessionsDir: string,
  sessionJson: string,
): SessionIndexEntry {
  fs.mkdirSync(sessionsDir, { recursive: true });

  const parsed: unknown = JSON.parse(sessionJson);
  const obj = parsed as Record<string, unknown>;
  const meta = obj.metadata as Record<string, unknown>;
  const ctx = obj.context as Record<string, unknown>;

  const snapshotFile = generateSnapshotFileName();
  fs.writeFileSync(path.join(sessionsDir, snapshotFile), sessionJson, "utf8");

  const entry: SessionIndexEntry = {
    sessionId: path.basename(snapshotFile, ".json"),
    snapshotFile,
    savedAt: typeof obj.savedAt === "string" ? obj.savedAt : "",
    providerName:
      typeof meta.providerName === "string" ? meta.providerName : "",
    modelKey: typeof meta.modelKey === "string" ? meta.modelKey : "",
    turnCount: Array.isArray(ctx.turns) ? ctx.turns.length : 0,
    hasRollingSummary: ctx.rollingSummary !== undefined,
  };

  const existing = readIndex(sessionsDir);
  const currentEntries = existing ? [...existing.entries] : [];
  currentEntries.unshift(entry);
  writeIndex(sessionsDir, { entries: currentEntries });

  return entry;
}

export function readSnapshot(
  sessionsDir: string,
  snapshotFile: string,
): string {
  return fs.readFileSync(path.join(sessionsDir, snapshotFile), "utf8");
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function listSessions(sessionsDir: string): SessionIndexEntry[] {
  let index = readIndex(sessionsDir);
  if (!index) {
    index = rebuildIndex(sessionsDir);
  }
  return [...index.entries].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function resolveLatestSession(
  sessionsDir: string,
): SessionIndexEntry | null {
  const sessions = listSessions(sessionsDir);
  return sessions.length > 0 ? sessions[0] : null;
}

export function resolveSessionById(
  sessionsDir: string,
  sessionId: string,
): SessionIndexEntry | null {
  const sessions = listSessions(sessionsDir);
  return sessions.find((s) => s.sessionId === sessionId) ?? null;
}
