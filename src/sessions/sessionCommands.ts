import { ConversationState } from "../context/types.js";
import {
  writeSnapshot,
  clearRecoveryCheckpoint,
  readSnapshot,
  listSessions,
  resolveLatestSession,
  resolveLatestRecoveryCheckpoint,
  resolveSessionById,
  SessionIndexEntry,
} from "./sessionHistory.js";

// ---------------------------------------------------------------------------
// IO abstraction for testability
// ---------------------------------------------------------------------------

export interface SessionCommandIO {
  info(message: string): void;
  error(message: string): void;
  success(message: string): void;
  command(message: string): void;
  promptConfirm(message: string): Promise<boolean>;
}

export interface SessionAgent {
  getConversationState(): ConversationState;
  exportSession(): string;
  importSession(json: string): void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function hasSessionContent(state: ConversationState): boolean {
  return (
    state.turns.length > 0 ||
    state.preamble.length > 0 ||
    state.artifacts.length > 0 ||
    state.pinnedMemory.length > 0 ||
    (state.invokedSkills?.length ?? 0) > 0 ||
    state.rollingSummary != null
  );
}

export function formatSessionEntry(entry: SessionIndexEntry): string {
  const date = new Date(entry.savedAt);
  const timeStr = date.toLocaleString();
  const turns = `${entry.turnCount} turn${entry.turnCount === 1 ? "" : "s"}`;
  const summary = entry.hasRollingSummary ? ", has summary" : "";
  const recovery = entry.recoveryCheckpoint ? ", recovery checkpoint" : "";
  return `${entry.sessionId}  ${timeStr}  ${entry.providerName}/${entry.modelKey}  ${turns}${summary}${recovery}`;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

export function saveSessionOnExit(
  agent: SessionAgent,
  sessionsDir: string,
  io: Pick<SessionCommandIO, "info" | "error">,
): void {
  if (!hasSessionContent(agent.getConversationState())) {
    return;
  }

  try {
    const json = agent.exportSession();
    const entry = writeSnapshot(sessionsDir, json);
    if (entry.runtimeSessionId) {
      try {
        clearRecoveryCheckpoint(sessionsDir, entry.runtimeSessionId);
      } catch (error) {
        io.error(
          `Session saved, but its recovery checkpoint could not be cleared: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    io.info(
      `Session saved: ${entry.sessionId} (${entry.turnCount} turn${entry.turnCount === 1 ? "" : "s"})`,
    );
  } catch (error) {
    io.error(
      `Failed to save session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function finishSessionCommand(io: SessionCommandIO): void {
  io.command("");
}

function listSavedSessions(sessionsDir: string, io: SessionCommandIO): void {
  const sessions = listSessions(sessionsDir);
  if (sessions.length === 0) {
    io.info("No saved sessions.");
  } else {
    io.info(`Saved sessions (${sessions.length}):`);
    for (const entry of sessions) io.command(formatSessionEntry(entry));
  }
  finishSessionCommand(io);
}

async function confirmSessionReplacement(
  agent: SessionAgent,
  io: SessionCommandIO,
): Promise<boolean> {
  if (!hasSessionContent(agent.getConversationState())) return true;
  return io.promptConfirm(
    "This will replace current session context and discard its recovery checkpoint. Continue? [y/N] ",
  );
}

async function loadSavedSession(
  sessionId: string,
  agent: SessionAgent,
  sessionsDir: string,
  io: SessionCommandIO,
  recoveryOnly = false,
): Promise<void> {
  const entry = resolveLoadEntry(sessionId, sessionsDir, recoveryOnly);

  if (!entry) {
    io.error(missingLoadMessage(sessionId, recoveryOnly));
    finishSessionCommand(io);
    return;
  }
  if (!(await confirmSessionReplacement(agent, io))) {
    io.info("Load cancelled.");
    finishSessionCommand(io);
    return;
  }

  try {
    agent.importSession(readSnapshot(sessionsDir, entry.snapshotFile));
    io.success(
      `Loaded ${entry.recoveryCheckpoint ? "recovery checkpoint" : "session"}: ${entry.sessionId} (${entry.turnCount} turn${entry.turnCount === 1 ? "" : "s"})`,
    );
  } catch (error) {
    io.error(
      `Failed to load session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  finishSessionCommand(io);
}

function resolveLoadEntry(
  sessionId: string,
  sessionsDir: string,
  recoveryOnly: boolean,
): SessionIndexEntry | null {
  if (sessionId) return resolveSessionById(sessionsDir, sessionId);
  return recoveryOnly
    ? resolveLatestRecoveryCheckpoint(sessionsDir)
    : resolveLatestSession(sessionsDir);
}

function missingLoadMessage(sessionId: string, recoveryOnly: boolean): string {
  if (sessionId) return `Session not found: ${sessionId}`;
  return recoveryOnly
    ? "No recovery checkpoints to load."
    : "No saved sessions to load.";
}

export async function handleSessionCommand(
  input: string,
  agent: SessionAgent,
  sessionsDir: string,
  io: SessionCommandIO,
): Promise<void> {
  const args = input.slice("/session".length).trim();

  if (args === "list") {
    listSavedSessions(sessionsDir, io);
    return;
  }

  if (args === "load" || args.startsWith("load ")) {
    const sessionId = args.slice("load".length).trim();
    await loadSavedSession(sessionId, agent, sessionsDir, io);
    return;
  }

  if (args === "recover") {
    await loadSavedSession("", agent, sessionsDir, io, true);
    return;
  }

  io.error(`Unknown /session subcommand: "${args}"`);
  io.command("Usage: /session list | /session load [<id>] | /session recover");
  io.command("");
}
