import * as fs from "fs";
import * as path from "path";

interface ReadJsonFileOptions {
  readonly invalidJsonPrefix: string;
  readonly missingMessage?: string;
  readonly onMissing?: () => unknown;
  readonly readErrorPrefix: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** The value to use for a file that could not be read, or the error to throw. */
function unreadableFile(error: unknown, options: ReadJsonFileOptions): unknown {
  if (isFileNotFound(error)) {
    if (options.onMissing) {
      return options.onMissing();
    }
    if (options.missingMessage) {
      throw new Error(options.missingMessage);
    }
  }

  throw new Error(`${options.readErrorPrefix}: ${getErrorMessage(error)}`);
}

function parseJsonContent(
  fileContent: string,
  options: ReadJsonFileOptions,
): unknown {
  try {
    return JSON.parse(fileContent);
  } catch (error) {
    throw new Error(`${options.invalidJsonPrefix}: ${getErrorMessage(error)}`);
  }
}

export function readJsonFile(
  filePath: string,
  options: ReadJsonFileOptions,
): unknown {
  let fileContent: string;

  try {
    fileContent = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return unreadableFile(error, options);
  }

  return parseJsonContent(fileContent, options);
}

export async function readJsonFileAsync(
  filePath: string,
  options: ReadJsonFileOptions,
): Promise<unknown> {
  let fileContent: string;

  try {
    fileContent = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    return unreadableFile(error, options);
  }

  return parseJsonContent(fileContent, options);
}

const PRIVATE_FILE_MODE = 0o600;

/**
 * The mode a private replacement gets: owner read and write, narrowed to
 * whatever stricter mode the file it replaces already has.
 */
function privateReplacementMode(filePath: string): number {
  try {
    return fs.statSync(filePath).mode & PRIVATE_FILE_MODE;
  } catch (error) {
    if (isFileNotFound(error)) return PRIVATE_FILE_MODE;
    throw error;
  }
}

export function writeJsonFileAtomic(
  filePath: string,
  tempFilePrefix: string,
  config: unknown,
  options: {
    /**
     * Never readable by other users. Replacing a file makes a new one, which
     * would otherwise take its mode from the process umask whatever the old
     * file's mode was.
     */
    readonly private?: boolean;
  } = {},
): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const tempFilePath = path.join(
    directory,
    `.${tempFilePrefix}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    if (options.private) {
      const mode = privateReplacementMode(filePath);
      // Private from the moment it exists, before any content is written.
      const descriptor = fs.openSync(tempFilePath, "wx", PRIVATE_FILE_MODE);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`, {
          encoding: "utf8",
        });
        fs.fchmodSync(descriptor, mode);
      } finally {
        fs.closeSync(descriptor);
      }
    } else {
      fs.writeFileSync(tempFilePath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: "utf8",
      });
    }
    fs.renameSync(tempFilePath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempFilePath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}
