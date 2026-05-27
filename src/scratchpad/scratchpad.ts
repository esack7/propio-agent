import * as fs from "fs";
import * as path from "path";
import { isSafeSessionId } from "../sessions/sessionId.js";
import { isSandboxMode } from "./sandbox.js";

export type ScratchpadResolveResult =
  | { ok: true; path: string }
  | { ok: false; path: string; errorName: string; message: string };

export function getScratchpadDir(
  sessionsDir: string,
  sessionId: string,
): string {
  if (!isSafeSessionId(sessionId)) {
    throw new Error("Invalid session id for scratchpad path");
  }
  return path.join(sessionsDir, "scratchpads", sessionId);
}

export function getSandboxScratchpadDir(sessionId: string): string {
  if (!isSafeSessionId(sessionId)) {
    throw new Error("Invalid session id for scratchpad path");
  }
  return path.join("/tmp", "propio-scratchpads", sessionId);
}

export function ensureDirectory0700(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  return path.resolve(dir);
}

export function removeEmptyScratchpadDir(dir: string | undefined): void {
  if (!dir) {
    return;
  }

  try {
    fs.rmdirSync(dir);
  } catch {
    // Keep directories that contain real scratch work, or when removal fails.
  }
}

export function resolveScratchpadDir(
  sessionsDir: string,
  sessionId: string,
): ScratchpadResolveResult {
  if (!isSafeSessionId(sessionId)) {
    return {
      ok: false,
      path: path.join(sessionsDir, "scratchpads", "(invalid-session-id)"),
      errorName: "InvalidSessionId",
      message: "Session id is not a safe path segment",
    };
  }

  const targetDir = isSandboxMode()
    ? getSandboxScratchpadDir(sessionId)
    : getScratchpadDir(sessionsDir, sessionId);

  try {
    return { ok: true, path: ensureDirectory0700(targetDir) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      ok: false,
      path: targetDir,
      errorName: err.name ?? "Error",
      message: err.message ?? String(error),
    };
  }
}
