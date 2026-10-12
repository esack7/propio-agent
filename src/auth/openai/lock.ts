import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join, basename } from "node:path";
import { checkPrivatePath, hasCode, privateDirectory } from "./secureFiles.js";

// fcntl locks are process-owned: serialize locally BEFORE opening another fd.
const owners = new Set<string>();

export async function withCredentialLock<T>(
  path: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + 15000;
  const wait = async () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline)
      throw new Error(
        "Another Propio process owns the account lock. Try again after it finishes.",
      );
    await delay(50, undefined, { signal });
  };
  path = join(await privateDirectory(dirname(path)), basename(path));
  while (owners.has(path)) await wait();
  owners.add(path);
  let file;
  try {
    const { lock, unlock } = await import("os-lock");
    file = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    await checkPrivatePath(path);
    while (true) {
      signal?.throwIfAborted();
      try {
        await lock(file.fd, { exclusive: true, immediate: true });
        break;
      } catch (error) {
        if (!["EACCES", "EAGAIN", "EBUSY"].some((code) => hasCode(error, code)))
          throw new Error(
            "OS account locking is unavailable. No credential operation was performed.",
          );
        await wait();
      }
    }
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      await unlock(file.fd);
    }
  } finally {
    await file?.close();
    owners.delete(path);
  }
  // Permanent inode: unlinking a lock would let another process lock a different inode.
}
