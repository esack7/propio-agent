import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const WAIT_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;
const BUSY_CODES = new Set(["EACCES", "EAGAIN", "EBUSY"]);

/** Thrown when this installation has no way to lock a file across processes. */
export class FileLockUnavailableError extends Error {
  constructor() {
    super(
      "File locking is unavailable: the optional os-lock package is not installed " +
        "or could not be built for this platform. Reinstall with optional " +
        "dependencies and a native build toolchain.",
    );
    this.name = "FileLockUnavailableError";
  }
}

type OsLock = typeof import("os-lock");

async function loadOsLock(): Promise<OsLock> {
  try {
    return await import("os-lock");
  } catch {
    throw new FileLockUnavailableError();
  }
}

/** Whether `withFileLock` can work here; it never creates or locks anything. */
export async function isFileLockAvailable(): Promise<boolean> {
  try {
    await loadOsLock();
    return true;
  } catch {
    return false;
  }
}

/** Operating-system locks belong to the process, so callers in it queue here first. */
const queues = new Map<string, Promise<void>>();

function isBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && BUSY_CODES.has(code);
}

/**
 * Run `operation` while holding an exclusive lock on `lockPath`, across this
 * process and every other that uses the same path. The lock is held by the
 * operating system, so it is released if the holder dies. The lock file is
 * never removed: unlinking it would let two processes lock different files.
 */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const previous = queues.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => turn);
  queues.set(lockPath, queued);
  await previous;
  try {
    return await lockedAcrossProcesses(
      lockPath,
      operation,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  } finally {
    release();
    if (queues.get(lockPath) === queued) queues.delete(lockPath);
  }
}

async function lockedAcrossProcesses<T>(
  lockPath: string,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const { lock, unlock } = await loadOsLock();
  await mkdir(dirname(lockPath), { recursive: true });
  const file = await open(
    lockPath,
    constants.O_RDWR | constants.O_CREAT,
    0o600,
  );
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await lock(file.fd, { exclusive: true, immediate: true });
        break;
      } catch (error) {
        if (!isBusy(error)) throw error;
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for another process to release ${lockPath}`,
          );
        }
        await delay(WAIT_MS);
      }
    }
    try {
      return await operation();
    } finally {
      await unlock(file.fd);
    }
  } finally {
    await file.close();
  }
}
