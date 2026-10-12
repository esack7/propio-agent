import { constants } from "node:fs";
import { mkdir, lstat, open, rename, unlink, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/** Validate a private leaf. Never repair a pre-existing unsafe credential path. */
export async function privateDirectory(path: string): Promise<string> {
  if (process.platform === "win32")
    throw new Error(
      "Windows subscription storage needs an owner-only ACL platform verification; this preview is unsupported on Windows.",
    );
  await mkdir(path, { recursive: true, mode: 0o700 });
  await validateParents(dirname(path));
  await checkPrivatePath(path, true);
  const parent = await realpath(dirname(path));
  return join(parent, path.split(/[\\/]/).slice(-1)[0]);
}

async function validateParents(path: string): Promise<void> {
  while (path !== dirname(path)) {
    const info = await lstat(path);
    if (info.isSymbolicLink() && info.uid !== 0)
      throw new Error(
        "Credential directories cannot use a user-owned parent symlink.",
      );
    const unsafeWrite = (info.mode & 0o022) !== 0;
    const systemSticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (unsafeWrite && !systemSticky)
      throw new Error(
        "Credential directory parent is writable by other users.",
      );
    path = dirname(path);
  }
}

export function parseProtectedJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(
      "Invalid protected credential record; its contents were omitted.",
    );
  }
}

export async function checkPrivatePath(
  path: string,
  directory = false,
): Promise<void> {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (!directory && info.nlink !== 1)
  )
    throw new Error(
      "Unsafe OpenAI credential path: require an owned private directory and owner-only regular files, without links.",
    );
}

export async function readPrivateFile(
  path: string,
): Promise<string | undefined> {
  try {
    await checkPrivatePath(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function atomicPrivateWrite(
  path: string,
  value: unknown,
): Promise<void> {
  await privateDirectory(dirname(path));
  try {
    await checkPrivatePath(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
