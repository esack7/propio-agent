import * as fsPromises from "fs/promises";
import * as path from "path";
import type { ToolDisplayAdapter } from "./displayAdapter.js";

const DEFAULT_OUTPUT_LIMIT = 50 * 1024;
const DEFAULT_TRUNCATION_MARKER = "[output truncated]";

const CONTROL_CHARACTERS = /[\x00-\x1f]/;
const BINARY_BYTE = 0x00;

export function normalizeToolPath(rawPath: unknown): string {
  return resolveToolPath(rawPath, process.cwd());
}

export function resolveToolPath(
  rawPath: unknown,
  workspaceRoot: string,
): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new Error("path must be a non-empty string");
  }

  if (CONTROL_CHARACTERS.test(rawPath)) {
    throw new Error("Invalid path: contains control characters");
  }

  const normalized = path.normalize(rawPath);
  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(workspaceRoot, normalized);
}

export function truncateText(
  value: string,
  limit: number = DEFAULT_OUTPUT_LIMIT,
  marker: string = DEFAULT_TRUNCATION_MARKER,
): { value: string; truncated: boolean } {
  if (value.length <= limit) {
    return { value, truncated: false };
  }

  return {
    value: `${value.slice(0, limit)}\n${marker}`,
    truncated: true,
  };
}

export async function readUtf8TextFile(filePath: string): Promise<string> {
  const buffer = await fsPromises.readFile(filePath);

  if (buffer.includes(BINARY_BYTE)) {
    throw new Error(`Path is a binary file, not a text file: ${filePath}`);
  }

  return buffer.toString("utf8");
}

export function createPathToolDisplayAdapter(): ToolDisplayAdapter {
  return {
    renderUse(input) {
      const path = input.path;
      return typeof path === "string" && path.length > 0 ? path : null;
    },
    renderResult(result) {
      return result;
    },
  };
}

export function getPathToolInvocationLabel(
  args: Record<string, unknown>,
  verb: string,
  fallback: string,
): string {
  const path = args.path;
  return typeof path === "string" && path.length > 0
    ? `${verb} ${path}`
    : fallback;
}

export function throwToolPathAccessError(
  err: NodeJS.ErrnoException | Error,
  rawPath: unknown,
): void {
  if (!("code" in err)) {
    return;
  }

  if (err.code === "EACCES" || err.code === "EPERM") {
    throw new Error(`Permission denied: ${rawPath}`);
  }

  if (err.code === "EISDIR") {
    throw new Error(`Path is a directory, not a file: ${rawPath}`);
  }
}

export function throwDirectoryOperationError(
  error: unknown,
  rawPath: unknown,
  operation: string,
  mapEnotdirToDirectoryError = false,
): never {
  const err = error as NodeJS.ErrnoException | Error;

  if (err instanceof Error && err.message.startsWith("Path is not a")) {
    throw err;
  }

  if ("code" in err && err.code === "ENOENT") {
    throw new Error(`Directory not found: ${rawPath}`);
  }

  if ("code" in err && (err.code === "EACCES" || err.code === "EPERM")) {
    throw new Error(`Permission denied: ${rawPath}`);
  }

  if (mapEnotdirToDirectoryError && "code" in err && err.code === "ENOTDIR") {
    throw new Error(`Path is not a directory: ${rawPath}`);
  }

  throw new Error(`Failed to ${operation}: ${err.message || String(error)}`);
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
}

export async function writeFileAtomically(
  filePath: string,
  content: string,
): Promise<void> {
  await ensureParentDirectory(filePath);

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;

  try {
    await fsPromises.writeFile(tempPath, content, "utf8");
    await fsPromises.rename(tempPath, filePath);
  } catch (error) {
    await fsPromises.rm(tempPath, { force: true });
    throw error;
  }
}

export function toStringArg(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

/**
 * Files under `rootPath` matching `pattern`, without leaving the root. Linked
 * directories are not descended into, and every entry, including one reached
 * through a directory the pattern names, is kept only when it resolves to a
 * file under the root. A search approved for one directory therefore never
 * reads or lists what a link inside it points to elsewhere.
 */
export async function listContainedFiles(
  rootPath: string,
  pattern = "**/*",
): Promise<string[]> {
  const realRoot = await fsPromises.realpath(rootPath);
  const fg = (await import("fast-glob")).default;
  const entries = await fg(pattern, {
    cwd: rootPath,
    absolute: true,
    onlyFiles: false,
    dot: false,
    followSymbolicLinks: false,
    objectMode: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const candidate = entry.dirent.isFile() || entry.dirent.isSymbolicLink();
    if (candidate && (await isFileInside(entry.path, realRoot))) {
      files.push(entry.path);
    }
  }
  return files;
}

async function isFileInside(
  entryPath: string,
  realRoot: string,
): Promise<boolean> {
  try {
    const target = await fsPromises.realpath(entryPath);
    const relative = path.relative(realRoot, target);
    const inside =
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
    return inside && (await fsPromises.stat(target)).isFile();
  } catch {
    // A broken link has nothing to search.
    return false;
  }
}

export async function collectFilesForSearch(
  rootPath: string,
): Promise<string[]> {
  const stats = await fsPromises.stat(rootPath);

  if (!stats.isDirectory()) {
    return [rootPath];
  }

  return await listContainedFiles(rootPath);
}

export function formatFileType(
  entry: {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  },
  name: string,
): string {
  if (entry.isDirectory()) {
    return `directory: ${name}/`;
  }
  if (entry.isSymbolicLink()) {
    return `symlink: ${name}`;
  }
  if (entry.isFile()) {
    return `file: ${name}`;
  }

  return `other: ${name}`;
}

export function throwFileOperationError(
  error: unknown,
  operation: string,
): never {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`Failed to ${operation} file: ${detail}`);
}
