import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { execSync } from "child_process";

const GLOBAL_SESSIONS_ROOT = path.join(os.homedir(), ".propio", "sessions");
const INDEX_FILE = "index.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionIndexEntry {
  readonly sessionId?: string;
  readonly runtimeSessionId?: string;
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
// Workspace resolution
// ---------------------------------------------------------------------------

export function resolveWorkspaceRoot(): string {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (gitRoot) return path.resolve(gitRoot);
  } catch {
    // not in a git repo or git unavailable
  }
  return path.resolve(process.cwd());
}

export function hashWorkspace(workspacePath: string): string {
  return crypto.createHash("sha256").update(workspacePath).digest("hex");
}

export function getWorkspaceSessionsDir(workspaceRoot?: string): string {
  const root = path.resolve(workspaceRoot ?? resolveWorkspaceRoot());
  return path.join(GLOBAL_SESSIONS_ROOT, hashWorkspace(root));
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getDefaultSessionsDir(): string {
  return getWorkspaceSessionsDir();
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
      const parsedSnapshot = parseSnapshotObject(JSON.parse(content));
      if (!parsedSnapshot) {
        continue;
      }

      entries.push(
        toSessionIndexEntry(
          file,
          parsedSnapshot.snapshot,
          parsedSnapshot.metadata,
          parsedSnapshot.context,
        ),
      );
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
 * Uses atomic write (temp file + rename) to avoid corruption on mid-write kill.
 */
export function writeSnapshot(
  sessionsDir: string,
  sessionJson: string,
): SessionIndexEntry {
  fs.mkdirSync(sessionsDir, { recursive: true });

  const parsedSnapshot = parseSnapshotObject(JSON.parse(sessionJson));
  if (!parsedSnapshot) {
    throw new Error("Invalid session snapshot format");
  }

  const snapshotFile = generateSnapshotFileName();
  const snapshotPath = path.join(sessionsDir, snapshotFile);
  const tempPath = `${snapshotPath}.tmp`;

  // Atomic write: temp file + rename
  fs.writeFileSync(tempPath, sessionJson, "utf8");
  fs.renameSync(tempPath, snapshotPath);

  const entry: SessionIndexEntry = toSessionIndexEntry(
    snapshotFile,
    parsedSnapshot.snapshot,
    parsedSnapshot.metadata,
    parsedSnapshot.context,
  );

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
// In-progress markers (crash telemetry)
// ---------------------------------------------------------------------------

export interface InProgressMarker {
  readonly pid: number;
  readonly startedAt: string;
  readonly providerName: string;
  readonly modelKey: string;
  readonly turnIndex: number;
}

function inProgressMarkerPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `inprogress-${sessionId}.json`);
}

/**
 * Write an in-progress marker to indicate a session is running.
 * Used to detect incomplete sessions if the process dies.
 */
export function writeInProgressMarker(
  sessionsDir: string,
  sessionId: string,
  marker: InProgressMarker,
): void {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const markerPath = inProgressMarkerPath(sessionsDir, sessionId);
  const tempPath = `${markerPath}.tmp`;

  // Atomic write like snapshot
  fs.writeFileSync(tempPath, JSON.stringify(marker, null, 2), "utf8");
  fs.renameSync(tempPath, markerPath);
}

/**
 * Clear an in-progress marker when the session completes normally.
 */
export function clearInProgressMarker(
  sessionsDir: string,
  sessionId: string,
): void {
  const markerPath = inProgressMarkerPath(sessionsDir, sessionId);
  if (fs.existsSync(markerPath)) {
    fs.unlinkSync(markerPath);
  }
}

/**
 * Find stale in-progress markers (processes that died without cleanup).
 * Returns markers whose process ID is no longer running or are very old.
 */
export interface StaleMarker {
  readonly sessionId: string;
  readonly marker: InProgressMarker;
  readonly ageMs: number;
}

export function findStaleMarkers(sessionsDir: string): StaleMarker[] {
  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  const staleMarkers: StaleMarker[] = [];
  const now = Date.now();
  const MAX_MARKER_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  const files = fs.readdirSync(sessionsDir);
  for (const file of files) {
    if (!file.startsWith("inprogress-") || !file.endsWith(".json")) {
      continue;
    }

    const sessionId = file.slice("inprogress-".length, -".json".length);
    try {
      const content = fs.readFileSync(path.join(sessionsDir, file), "utf8");
      const marker = JSON.parse(content) as InProgressMarker;

      const startedAtMs = new Date(marker.startedAt).getTime();
      const ageMs = now - startedAtMs;

      // Check if process is still running
      let processRunning = false;
      try {
        // On Unix, kill with signal 0 checks if process exists
        execSync(`kill -0 ${marker.pid}`, { stdio: "ignore" });
        processRunning = true;
      } catch {
        processRunning = false;
      }

      if (!processRunning || ageMs > MAX_MARKER_AGE_MS) {
        staleMarkers.push({ sessionId, marker, ageMs });
      }
    } catch {
      // Skip malformed markers
    }
  }

  return staleMarkers;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshotObject(parsed: unknown): {
  snapshot: Record<string, unknown>;
  metadata: Record<string, unknown>;
  context: Record<string, unknown>;
} | null {
  if (!isRecord(parsed)) {
    return null;
  }

  const snapshot = parsed;
  if (
    snapshot.version !== 1 &&
    snapshot.version !== 2 &&
    snapshot.version !== 3
  ) {
    return null;
  }

  const metadata = snapshot.metadata;
  const context = snapshot.context;
  if (!isRecord(metadata) || !isRecord(context)) {
    return null;
  }

  return { snapshot, metadata, context };
}

function toSessionIndexEntry(
  snapshotFile: string,
  snapshot: Record<string, unknown>,
  metadata: Record<string, unknown>,
  context: Record<string, unknown>,
): SessionIndexEntry {
  return {
    sessionId: path.basename(snapshotFile, ".json"),
    runtimeSessionId:
      typeof metadata.sessionId === "string" ? metadata.sessionId : undefined,
    snapshotFile,
    savedAt: typeof snapshot.savedAt === "string" ? snapshot.savedAt : "",
    providerName:
      typeof metadata.providerName === "string" ? metadata.providerName : "",
    modelKey: typeof metadata.modelKey === "string" ? metadata.modelKey : "",
    turnCount: Array.isArray(context.turns) ? context.turns.length : 0,
    hasRollingSummary: context.rollingSummary !== undefined,
  };
}
