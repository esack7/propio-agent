import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  persistArtifact,
  persistEntry,
  persistMessage,
  persistPinnedMemory,
  persistTurn,
} from "../context/codec.js";
import type { ConversationRecoveryChange } from "../context/conversationManager.js";
import type { SessionMetadata } from "../context/persistence.js";
import { parseSession } from "../context/persistence.js";
import type { InvokedSkillRecord } from "../skills/types.js";
import { isSafeSessionId } from "./sessionId.js";

export interface RecoveryJournalPosition {
  readonly nextSequence: number;
  readonly offset: number;
}

interface JournalBody {
  readonly version: 1;
  readonly sequence: number;
  readonly kind: "base" | "delta";
  readonly payload: unknown;
}

interface JournalRecord extends JournalBody {
  readonly sha256: string;
}

function journalPath(sessionsDir: string, sessionId: string): string {
  if (!isSafeSessionId(sessionId)) throw new Error("Unsafe session ID");
  return path.join(sessionsDir, `recovery-${sessionId}.jsonl`);
}

function encodeRecord(body: JournalBody): Buffer {
  const sha256 = crypto
    .createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  return Buffer.from(`${JSON.stringify({ ...body, sha256 })}\n`, "utf8");
}

function writeAll(fd: number, bytes: Buffer, position: number): void {
  let written = 0;
  while (written < bytes.length) {
    const count = fs.writeSync(
      fd,
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    if (count <= 0) throw new Error("Recovery journal write made no progress");
    written += count;
  }
}

function syncDirectory(sessionsDir: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(sessionsDir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Atomically establish a new journal baseline; older checkpoints remain until rename. */
export function writeRecoveryJournalBase(
  sessionsDir: string,
  sessionJson: string,
): RecoveryJournalPosition {
  const session = parseSession(sessionJson);
  if (session.version !== 4) {
    throw new Error("Recovery journal baseline requires session version 4");
  }
  const sessionId = session.metadata.sessionId;
  if (!sessionId || !isSafeSessionId(sessionId)) {
    throw new Error("Recovery journal requires a safe runtime session ID");
  }
  const checkpoint = {
    ...session,
    metadata: { ...session.metadata, recoveryCheckpoint: true },
  };
  const bytes = encodeRecord({
    version: 1,
    sequence: 0,
    kind: "base",
    payload: checkpoint,
  });
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const target = journalPath(sessionsDir, sessionId);
  const temp = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      writeAll(fd, bytes, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
    syncDirectory(sessionsDir);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // A failed baseline must not affect the running tool sequence.
    }
    throw error;
  }
  return { nextSequence: 1, offset: bytes.length };
}

function encodeChange(
  change: ConversationRecoveryChange,
): Record<string, unknown> {
  switch (change.kind) {
    case "turn_added":
      return { kind: change.kind, turn: persistTurn(change.turn) };
    case "assistant_added":
      return {
        kind: change.kind,
        turnId: change.turnId,
        entry: persistEntry(change.entry),
        turn: change.turn,
      };
    case "tool_results_added":
      return {
        kind: change.kind,
        turnId: change.turnId,
        entry: persistEntry(change.entry),
        artifacts: change.artifacts.map(persistArtifact),
        appendToToolEntry: change.appendToToolEntry,
      };
    case "preamble_added":
      return {
        kind: change.kind,
        message: persistMessage(change.message),
        artifacts: change.artifacts?.map(persistArtifact) ?? [],
      };
    case "memory_set":
      return {
        kind: change.kind,
        records: change.records.map(persistPinnedMemory),
      };
    default:
      return { ...change };
  }
}

/** Append only the changes since the last durable position, then fsync. */
export function appendRecoveryJournal(
  sessionsDir: string,
  sessionId: string,
  position: RecoveryJournalPosition,
  metadata: SessionMetadata,
  changes: readonly ConversationRecoveryChange[],
  invokedSkills: readonly InvokedSkillRecord[],
): RecoveryJournalPosition {
  if (metadata.sessionId !== sessionId)
    throw new Error("Recovery session ID changed");
  const bytes = encodeRecord({
    version: 1,
    sequence: position.nextSequence,
    kind: "delta",
    payload: {
      savedAt: new Date().toISOString(),
      metadata: { ...metadata, recoveryCheckpoint: true },
      changes: changes.map(encodeChange),
      invokedSkills,
    },
  });
  const filePath = journalPath(sessionsDir, sessionId);
  if (!fs.lstatSync(filePath).isFile()) {
    throw new Error("Recovery journal is not a regular file");
  }
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Recovery journal is not a private regular file");
    if (stat.size < position.offset) {
      throw new Error("Recovery journal was shortened unexpectedly");
    }
    if (stat.size > position.offset) {
      fs.ftruncateSync(fd, position.offset);
    }
    writeAll(fd, bytes, position.offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return {
    nextSequence: position.nextSequence + 1,
    offset: position.offset + bytes.length,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid recovery journal object");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid recovery journal array");
  return value;
}

function lastTurn(
  snapshot: Record<string, unknown>,
  turnId: unknown,
): Record<string, unknown> {
  const context = asObject(snapshot.context);
  const turns = asArray(context.turns);
  const turn = asObject(turns[turns.length - 1]);
  if (turn.id !== turnId) throw new Error("Recovery journal turn mismatch");
  return turn;
}

function applyToolResults(
  snapshot: Record<string, unknown>,
  change: Record<string, unknown>,
): void {
  const context = asObject(snapshot.context);
  const turn = lastTurn(snapshot, change.turnId);
  const entries = asArray(turn.entries);
  const entry = asObject(change.entry);
  if (entry.kind !== "tool") throw new Error("Invalid recovery tool entry");
  if (change.appendToToolEntry === true) {
    const previous = asObject(entries[entries.length - 1]);
    if (previous.kind !== "tool")
      throw new Error("Recovery tool entry mismatch");
    const message = asObject(previous.message);
    asArray(message.toolResults).push(
      ...asArray(asObject(entry.message).toolResults),
    );
    asArray(previous.toolInvocations).push(...asArray(entry.toolInvocations));
    previous.estimatedTokens = entry.estimatedTokens;
  } else {
    entries.push(entry);
  }
  asArray(context.artifacts).push(...asArray(change.artifacts));
}

function removeLastTurn(
  snapshot: Record<string, unknown>,
  change: Record<string, unknown>,
): void {
  const context = asObject(snapshot.context);
  const turns = asArray(context.turns);
  if (asObject(turns[turns.length - 1]).id !== change.turnId)
    throw new Error("Recovery turn removal mismatch");
  turns.pop();
  const removed = new Set(asArray(change.artifactIds));
  context.artifacts = asArray(context.artifacts).filter(
    (artifact) => !removed.has(asObject(artifact).id),
  );
}

function addAssistantEntry(
  snapshot: Record<string, unknown>,
  change: Record<string, unknown>,
): void {
  const turn = lastTurn(snapshot, change.turnId);
  asArray(turn.entries).push(change.entry);
  const update = asObject(change.turn);
  if (update.completedAt !== undefined) turn.completedAt = update.completedAt;
  if (update.estimatedTokens !== undefined)
    turn.estimatedTokens = update.estimatedTokens;
}

function applyTurnChange(
  snapshot: Record<string, unknown>,
  change: Record<string, unknown>,
): boolean {
  switch (change.kind) {
    case "turn_added":
      asArray(asObject(snapshot.context).turns).push(change.turn);
      return true;
    case "turn_removed":
      removeLastTurn(snapshot, change);
      return true;
    case "assistant_added":
      addAssistantEntry(snapshot, change);
      return true;
    case "assistant_removed":
      asArray(lastTurn(snapshot, change.turnId).entries).pop();
      return true;
    case "tool_results_added":
      applyToolResults(snapshot, change);
      return true;
    default:
      return false;
  }
}

function applyChange(snapshot: Record<string, unknown>, value: unknown): void {
  const change = asObject(value);
  if (applyTurnChange(snapshot, change)) return;
  const context = asObject(snapshot.context);
  switch (change.kind) {
    case "preamble_added":
      asArray(context.preamble).push(change.message);
      asArray(context.artifacts).push(...asArray(change.artifacts));
      return;
    case "preamble_removed":
      asArray(context.preamble).pop();
      return;
    case "summary_set":
      context.rollingSummary = change.summary;
      return;
    case "memory_set":
      context.pinnedMemory = asArray(change.records);
      return;
    default:
      throw new Error("Unknown recovery journal change");
  }
}

function applyDelta(snapshot: Record<string, unknown>, payload: unknown): void {
  const delta = asObject(payload);
  const metadata = asObject(delta.metadata);
  if (metadata.sessionId !== asObject(snapshot.metadata).sessionId)
    throw new Error("Recovery journal session mismatch");
  for (const change of asArray(delta.changes)) applyChange(snapshot, change);
  snapshot.savedAt = delta.savedAt;
  snapshot.metadata = metadata;
  const context = asObject(snapshot.context);
  asArray(context.invokedSkills).push(...asArray(delta.invokedSkills));
}

function decodeRecord(line: Buffer, sequence: number): JournalRecord {
  const record = asObject(JSON.parse(line.toString("utf8")));
  const { sha256, ...body } = record;
  if (
    record.version !== 1 ||
    record.sequence !== sequence ||
    (record.kind !== "base" && record.kind !== "delta") ||
    typeof sha256 !== "string" ||
    crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") !==
      sha256
  ) {
    throw new Error("Invalid recovery journal record");
  }
  return record as unknown as JournalRecord;
}

function nextCompleteRecord(
  bytes: Buffer,
  offset: number,
  sequence: number,
): { record: JournalRecord; end: number } | null {
  const newline = bytes.indexOf(10, offset);
  if (newline < 0) return null;
  try {
    return {
      record: decodeRecord(bytes.subarray(offset, newline), sequence),
      end: newline + 1,
    };
  } catch {
    return null;
  }
}

function replayRecord(
  record: JournalRecord,
  snapshot: Record<string, unknown> | undefined,
  sessionId: string,
): Record<string, unknown> {
  if (record.kind === "base") {
    if (snapshot) throw new Error("Duplicate recovery journal baseline");
    const baseline = asObject(record.payload);
    if (asObject(baseline.metadata).sessionId !== sessionId)
      throw new Error("Recovery baseline session mismatch");
    return baseline;
  }
  if (!snapshot) throw new Error("Recovery journal has no baseline");
  applyDelta(snapshot, record.payload);
  return snapshot;
}

/** Read the last complete, checksummed prefix; an interrupted tail is ignored. */
export function readRecoveryJournal(
  sessionsDir: string,
  sessionId: string,
): { json: string; position: RecoveryJournalPosition } | null {
  const filePath = journalPath(sessionsDir, sessionId);
  if (!fs.lstatSync(filePath).isFile()) return null;
  const bytes = fs.readFileSync(filePath);
  let snapshot: Record<string, unknown> | undefined;
  let offset = 0;
  let sequence = 0;
  while (offset < bytes.length) {
    const next = nextCompleteRecord(bytes, offset, sequence);
    if (!next) break;
    try {
      snapshot = replayRecord(next.record, snapshot, sessionId);
    } catch {
      return null;
    }
    offset = next.end;
    sequence++;
  }
  if (!snapshot) return null;
  const json = JSON.stringify(snapshot);
  parseSession(json);
  return { json, position: { nextSequence: sequence, offset } };
}
