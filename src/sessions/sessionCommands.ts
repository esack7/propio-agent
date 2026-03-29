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

export async function handleSessionCommand(
  input: string,
  agent: SessionAgent,
  sessionsDir: string,
  io: SessionCommandIO,
): Promise<void> {
  const args = input.slice("/session".length).trim();

  if (args === "list") {
    const sessions = listSessions(sessionsDir);
    if (sessions.length === 0) {
      io.info("No saved sessions.");
    } else {
      io.info(`Saved sessions (${sessions.length}):`);
      for (const entry of sessions) {
        io.command(formatSessionEntry(entry));
      }
    }
    io.command("");
    return;
  }

  if (args === "load" || args.startsWith("load ")) {
    const sessionId = args.slice("load".length).trim();

    const entry = sessionId
      ? resolveSessionById(sessionsDir, sessionId)
      : resolveLatestSession(sessionsDir);

    if (!entry) {
      if (sessionId) {
        io.error(`Session not found: ${sessionId}`);
      } else {
        io.error("No saved sessions to load.");
      }
      io.command("");
      return;
    }

    if (hasSessionContent(agent.getConversationState())) {
      const confirmed = await io.promptConfirm(
        "This will replace current session context. Continue? [y/N] ",
      );
      if (!confirmed) {
        io.info("Load cancelled.");
        io.command("");
        return;
      }
    }

    try {
      const json = readSnapshot(sessionsDir, entry.snapshotFile);
      agent.importSession(json);
      io.success(
        `Loaded session: ${entry.sessionId} (${entry.turnCount} turn${entry.turnCount === 1 ? "" : "s"})`,
      );
    } catch (error) {
      io.error(
        `Failed to load session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    io.command("");
    return;
  }

  io.error(`Unknown /session subcommand: "${args}"`);
  io.command("Usage: /session list | /session load [<id>]");
  io.command("");
}
