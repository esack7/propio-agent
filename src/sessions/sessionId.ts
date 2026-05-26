const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Snapshot basename style ids, e.g. 2026-03-29T10-00-00.000Z-abc123 */
const SNAPSHOT_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Session ids are used as single path segments (scratchpads, artifacts, markers).
 * Rejects separators, traversal, and other unsafe values.
 */
export function isSafeSessionId(sessionId: string): boolean {
  if (sessionId.length === 0 || sessionId.length > 128) {
    return false;
  }
  if (sessionId === "." || sessionId === "..") {
    return false;
  }
  if (sessionId.includes("/") || sessionId.includes("\\")) {
    return false;
  }
  if (sessionId.includes("..")) {
    return false;
  }
  return UUID_RE.test(sessionId) || SNAPSHOT_SESSION_ID_RE.test(sessionId);
}
