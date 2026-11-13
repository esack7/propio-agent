import type { Dirent } from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { Minimatch } from "minimatch";

/** Lists one directory. Replaceable so a test can see every directory opened. */
export type ReadDirectory = (directory: string) => Promise<Dirent[]>;

const readDirectoryEntries: ReadDirectory = (directory) =>
  fsPromises.readdir(directory, { withFileTypes: true });

/**
 * Files under `rootPath` whose path relative to it matches `pattern`. The
 * walk starts at the root and opens only directories found inside it, so a
 * pattern can never name its way out (`../x`, `/abs`), and a linked directory
 * is never entered, even when the pattern names it. A linked file is kept
 * only when it resolves to a file under the root. A search approved for one
 * directory therefore never opens, lists, or reads anything outside it.
 *
 * Hidden entries are matched only when the pattern names them, and a
 * subdirectory that cannot be read is skipped.
 */
export async function listContainedFiles(
  rootPath: string,
  pattern = "**/*",
  readDirectory: ReadDirectory = readDirectoryEntries,
): Promise<string[]> {
  const matcher = new Minimatch(pattern.replace(/^(\.\/)+/, ""), {
    dot: false,
    nocomment: true,
    nonegate: true,
  });
  const walk = new ContainedWalk(
    matcher,
    await fsPromises.realpath(rootPath),
    readDirectory,
  );
  await walk.directory(rootPath, "");
  return walk.files;
}

function byName(a: Dirent, b: Dirent): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

class ContainedWalk {
  readonly files: string[] = [];

  constructor(
    private readonly matcher: Minimatch,
    private readonly realRoot: string,
    private readonly readDirectory: ReadDirectory,
  ) {}

  async directory(directory: string, relative: string): Promise<void> {
    const entries = await this.list(directory, relative);
    for (const entry of entries.sort(byName)) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      await this.entry(entry, path.join(directory, entry.name), entryRelative);
    }
  }

  /** The root must be readable; an unreadable subdirectory is skipped. */
  private async list(directory: string, relative: string): Promise<Dirent[]> {
    try {
      return await this.readDirectory(directory);
    } catch (error) {
      if (relative === "") throw error;
      return [];
    }
  }

  private async entry(
    entry: Dirent,
    entryPath: string,
    relative: string,
  ): Promise<void> {
    if (entry.isDirectory()) {
      // Enter only directories the pattern could still match beneath.
      if (this.matcher.match(relative, true)) {
        await this.directory(entryPath, relative);
      }
      return;
    }
    if (this.matcher.match(relative) && (await this.isFile(entry, entryPath))) {
      this.files.push(entryPath);
    }
  }

  private async isFile(entry: Dirent, entryPath: string): Promise<boolean> {
    if (entry.isFile()) return true;
    return (
      entry.isSymbolicLink() && (await isFileInside(entryPath, this.realRoot))
    );
  }
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
