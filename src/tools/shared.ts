import * as fsPromises from "fs/promises";
import * as path from "path";

export const DEFAULT_OUTPUT_LIMIT = 50 * 1024;
export const DEFAULT_TRUNCATION_MARKER = "[output truncated]";

const CONTROL_CHARACTERS = /[\x00-\x1f]/;
const BINARY_BYTE = 0x00;

export function normalizeToolPath(rawPath: unknown): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new Error("path must be a non-empty string");
  }

  if (CONTROL_CHARACTERS.test(rawPath)) {
    throw new Error("Invalid path: contains control characters");
  }

  const normalized = path.normalize(rawPath);
  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(process.cwd(), normalized);
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

export async function ensureParentDirectory(filePath: string): Promise<void> {
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

export async function collectFilesForSearch(
  rootPath: string,
): Promise<string[]> {
  const stats = await fsPromises.stat(rootPath);

  if (!stats.isDirectory()) {
    return [rootPath];
  }

  const fg = (await import("fast-glob")).default;
  return await fg("**/*", {
    cwd: rootPath,
    absolute: true,
    onlyFiles: true,
    dot: false,
  });
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
