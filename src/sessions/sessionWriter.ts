import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import * as path from "node:path";
import { isSafeSessionId } from "./sessionId.js";

const held = new Set<string>();

/** OS-owned lock: the permanent lock file is never unlinked. */
export async function acquireSessionWriter(
  directory: string,
  sessionId: string,
): Promise<() => Promise<void>> {
  if (!isSafeSessionId(sessionId))
    throw new Error("Invalid session writer identity");
  const { lock, unlock } = await import("os-lock");
  const lockDirectory = path.join(directory, "writers");
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = await realpath(directory);
  if (
    (await realpath(lockDirectory)) !== path.join(canonicalDirectory, "writers")
  )
    throw new Error("Unsafe session writer directory");
  const filename = path.join(
    canonicalDirectory,
    "writers",
    `${sessionId}.lock`,
  );
  if (held.has(filename))
    throw new Error(`Session ${sessionId} is already open for writing`);
  held.add(filename);
  const file = await open(
    filename,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  ).catch((error: unknown) => {
    held.delete(filename);
    throw error;
  });
  try {
    await lock(file.fd, { exclusive: true, immediate: true });
  } catch (cause) {
    held.delete(filename);
    await file.close();
    throw new Error(
      `Session ${sessionId} is already open for writing; close its other CLI process and retry (${String(cause)})`,
    );
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await unlock(file.fd);
    } finally {
      await file.close();
      held.delete(filename);
    }
  };
}
