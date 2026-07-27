import { ConversationState } from "../context/types.js";
import {
  writeSnapshot,
  readSnapshot,
  listSessions,
  resolveLatestSession,
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
  return `${entry.sessionId}  ${timeStr}  ${entry.providerName}/${entry.modelKey}  ${turns}${summary}`;
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
    "This will replace current session context. Continue? [y/N] ",
  );
}

async function loadSavedSession(
  sessionId: string,
  agent: SessionAgent,
  sessionsDir: string,
  io: SessionCommandIO,
): Promise<void> {
  const entry = sessionId
    ? resolveSessionById(sessionsDir, sessionId)
    : resolveLatestSession(sessionsDir);

  if (!entry) {
    io.error(
      sessionId
        ? `Session not found: ${sessionId}`
        : "No saved sessions to load.",
    );
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
      `Loaded session: ${entry.sessionId} (${entry.turnCount} turn${entry.turnCount === 1 ? "" : "s"})`,
    );
  } catch (error) {
    io.error(
      `Failed to load session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  finishSessionCommand(io);
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

  io.error(`Unknown /session subcommand: "${args}"`);
  io.command("Usage: /session list | /session load [<id>]");
  io.command("");
}
