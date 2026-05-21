import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

type FileSearchEntryKind = "file" | "directory";

interface FileSearchEntry {
  readonly path: string;
  readonly lowerPath: string;
  readonly kind: FileSearchEntryKind;
}

export interface FileSearchMatch {
  readonly path: string;
  readonly kind: FileSearchEntryKind;
  readonly score: number;
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".propio",
]);

const REFRESH_THROTTLE_MS = 5000;

function isBoundaryCharacter(character: string | undefined): boolean {
  return (
    character === "/" ||
    character === "-" ||
    character === "_" ||
    character === "." ||
    character === " " ||
    character === undefined
  );
}

function countPathDepth(value: string): number {
  const normalized = value.endsWith(path.sep) ? value.slice(0, -1) : value;
  if (normalized.length === 0) {
    return 0;
  }
  return normalized.split(path.sep).length;
}

function shouldIgnorePath(relativePath: string): boolean {
  const segments = relativePath.split(path.sep);
  return segments.some((segment) => IGNORED_DIRECTORIES.has(segment));
}

function toWorkspaceRelative(
  absolutePath: string,
  workspaceRoot: string,
): string | null {
  const relative = path.relative(workspaceRoot, absolutePath);
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  return path.normalize(relative);
}

function collectDirectoryPrefixes(relativePath: string): string[] {
  const normalized = relativePath.endsWith(path.sep)
    ? relativePath.slice(0, -1)
    : relativePath;
  const segments = normalized.split(path.sep);
  const prefixes: string[] = [];

  for (let index = 1; index < segments.length; index += 1) {
    prefixes.push(`${segments.slice(0, index).join(path.sep)}${path.sep}`);
  }

  return prefixes;
}

function appendEntry(
  entries: FileSearchEntry[],
  seen: Set<string>,
  entryPath: string,
  kind: FileSearchEntryKind,
): void {
  if (seen.has(entryPath)) {
    return;
  }

  seen.add(entryPath);
  entries.push({
    path: entryPath,
    lowerPath: entryPath.toLowerCase(),
    kind,
  });
}

function resolveSearchEntryPath(
  absoluteOrRelative: string,
  workspaceRoot: string,
): string | null {
  const absolutePath = path.isAbsolute(absoluteOrRelative)
    ? absoluteOrRelative
    : path.resolve(workspaceRoot, absoluteOrRelative);
  const relativePath = toWorkspaceRelative(absolutePath, workspaceRoot);
  if (!relativePath || shouldIgnorePath(relativePath)) {
    return null;
  }
  return relativePath;
}

function appendDirectoryEntries(
  entries: FileSearchEntry[],
  seen: Set<string>,
  relativePath: string,
): void {
  for (const directoryPrefix of collectDirectoryPrefixes(relativePath)) {
    if (shouldIgnorePath(directoryPrefix)) {
      continue;
    }
    appendEntry(entries, seen, directoryPrefix, "directory");
  }
}

function createEntries(
  paths: readonly string[],
  workspaceRoot: string,
): FileSearchEntry[] {
  const seen = new Set<string>();
  const entries: FileSearchEntry[] = [];

  for (const absoluteOrRelative of paths) {
    const relativePath = resolveSearchEntryPath(
      absoluteOrRelative,
      workspaceRoot,
    );
    if (!relativePath) {
      continue;
    }

    appendEntry(entries, seen, relativePath, "file");
    appendDirectoryEntries(entries, seen, relativePath);
  }

  return entries;
}

function runCommand(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => {
      resolve({
        code: 127,
        stdout,
        stderr,
      });
    });
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function parseCommandLines(output: string): string[] {
  return output
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function computeSignature(entries: readonly FileSearchEntry[]): string {
  return entries
    .map((entry) => `${entry.kind}:${entry.path}`)
    .sort((left, right) => left.localeCompare(right))
    .join("\n");
}

function compareMatches(left: FileSearchMatch, right: FileSearchMatch): number {
  if (left.score !== right.score) {
    return left.score - right.score;
  }
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return left.path.localeCompare(right.path);
}

function scoreQueryMatch(
  needle: string,
  haystack: string,
  originalPath: string,
): number | null {
  let score = 0;
  let previousIndex = -1;

  for (const character of needle) {
    const index = haystack.indexOf(character, previousIndex + 1);
    if (index < 0) {
      return null;
    }

    if (previousIndex >= 0) {
      const gap = index - previousIndex - 1;
      score += gap * 0.75;
      if (index === previousIndex + 1) {
        score -= 1.75;
      }
    }

    if (index === 0) {
      score -= 4;
    } else if (isBoundaryCharacter(originalPath[index - 1])) {
      score -= 2;
    }

    previousIndex = index;
  }

  return score;
}

function applyBasenamePenalty(
  score: number,
  entry: FileSearchEntry,
  query: string,
  caseSensitive: boolean,
): number {
  const normalizedPath =
    entry.kind === "directory" ? entry.path.slice(0, -1) : entry.path;
  const basename = path.basename(normalizedPath);
  const normalizedNeedle = caseSensitive ? query : query.toLowerCase();
  const normalizedBasename = caseSensitive ? basename : basename.toLowerCase();

  return normalizedBasename.startsWith(normalizedNeedle) ? score - 3 : score;
}

function applyPathPenalties(score: number, entry: FileSearchEntry): number {
  let nextScore = score;
  if (entry.lowerPath.includes("test")) {
    nextScore += 0.35;
  }
  nextScore += entry.path.length * 0.04;
  if (entry.kind === "directory") {
    nextScore -= 0.1;
  }
  return nextScore;
}

function scoreCandidate(entry: FileSearchEntry, query: string): number | null {
  if (query.length === 0) {
    return (
      countPathDepth(entry.path) + (entry.kind === "directory" ? -0.25 : 0)
    );
  }

  const caseSensitive = /[A-Z]/.test(query);
  const needle = caseSensitive ? query : query.toLowerCase();
  const haystack = caseSensitive ? entry.path : entry.lowerPath;
  const score = scoreQueryMatch(needle, haystack, entry.path);
  if (score === null) {
    return null;
  }

  return applyPathPenalties(
    applyBasenamePenalty(score, entry, query, caseSensitive),
    entry,
  );
}

export class FileSearchIndex {
  private static readonly cache = new Map<string, FileSearchIndex>();

  static forWorkspace(workspaceRoot: string): FileSearchIndex {
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    const cached = FileSearchIndex.cache.get(resolvedWorkspaceRoot);
    if (cached) {
      return cached;
    }

    const index = new FileSearchIndex(resolvedWorkspaceRoot);
    FileSearchIndex.cache.set(resolvedWorkspaceRoot, index);
    return index;
  }

  private entries: FileSearchEntry[] = [];
  private buildPromise: Promise<void> | null = null;
  private lastRefreshStartedAt = 0;
  private lastSignature = "";
  private lastGitIndexMtimeMs = 0;

  constructor(private readonly workspaceRoot: string) {
    void this.refresh(true);
  }

  private async readGitPaths(): Promise<string[]> {
    const gitTrackedResult = await runCommand(this.workspaceRoot, "git", [
      "ls-files",
      "--cached",
      "--recurse-submodules",
    ]);
    const gitUntrackedResult = await runCommand(this.workspaceRoot, "git", [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);

    if (gitTrackedResult.code === 0 && gitUntrackedResult.code === 0) {
      return [
        ...parseCommandLines(gitTrackedResult.stdout),
        ...parseCommandLines(gitUntrackedResult.stdout),
      ];
    }

    const gitResult = await runCommand(this.workspaceRoot, "git", [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);

    if (gitResult.code === 0) {
      return parseCommandLines(gitResult.stdout);
    }

    const rgResult = await runCommand(this.workspaceRoot, "rg", [
      "--files",
      "--hidden",
      "--no-messages",
    ]);

    if (rgResult.code === 0) {
      return parseCommandLines(rgResult.stdout);
    }

    return this.readFilesystemPaths();
  }

  // fallow-ignore-next-line complexity
  private readFilesystemPaths(): string[] {
    const paths: string[] = [];
    const stack = [this.workspaceRoot];

    while (stack.length > 0) {
      const currentDir = stack.pop();
      if (!currentDir) {
        continue;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }

        const absolutePath = path.join(currentDir, entry.name);
        const relativePath = toWorkspaceRelative(
          absolutePath,
          this.workspaceRoot,
        );
        if (!relativePath || shouldIgnorePath(relativePath)) {
          continue;
        }

        if (entry.isDirectory()) {
          stack.push(absolutePath);
          continue;
        }

        if (entry.isFile()) {
          paths.push(relativePath);
        }
      }
    }

    return paths;
  }

  private loadGitIndexMtime(): number {
    const gitIndexPath = path.join(this.workspaceRoot, ".git", "index");
    try {
      return fs.statSync(gitIndexPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private async rebuild(): Promise<void> {
    const paths = await this.readGitPaths();
    const entries = createEntries(paths, this.workspaceRoot);
    const signature = computeSignature(entries);

    if (signature === this.lastSignature) {
      this.entries = entries;
      return;
    }

    this.entries = entries;
    this.lastSignature = signature;
  }

  async refresh(force = false): Promise<void> {
    if (this.buildPromise) {
      return this.buildPromise;
    }

    const now = Date.now();
    const gitIndexMtime = this.loadGitIndexMtime();
    const indexChanged = gitIndexMtime !== this.lastGitIndexMtimeMs;
    if (
      !force &&
      !indexChanged &&
      this.lastRefreshStartedAt > 0 &&
      now - this.lastRefreshStartedAt < REFRESH_THROTTLE_MS
    ) {
      return;
    }

    this.lastRefreshStartedAt = now;
    this.lastGitIndexMtimeMs = gitIndexMtime;
    this.buildPromise = this.rebuild()
      .catch(() => {
        // Keep the current entries on refresh failure. Search remains
        // non-blocking and will retry on the next explicit refresh.
      })
      .finally(() => {
        this.buildPromise = null;
      });

    return this.buildPromise;
  }

  search(query: string, limit = 20): FileSearchMatch[] {
    const trimmedQuery = query.trim();
    if (this.entries.length === 0) {
      void this.refresh(true);
      return [];
    }

    void this.refresh();

    if (trimmedQuery.length === 0) {
      return [...this.entries]
        .sort((left, right) => {
          const depthDelta =
            countPathDepth(left.path) - countPathDepth(right.path);
          if (depthDelta !== 0) {
            return depthDelta;
          }
          if (left.kind !== right.kind) {
            return left.kind === "directory" ? -1 : 1;
          }
          return left.path.localeCompare(right.path);
        })
        .slice(0, limit)
        .map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          score: 0,
        }));
    }

    const matches: FileSearchMatch[] = [];

    for (const entry of this.entries) {
      const score = scoreCandidate(entry, trimmedQuery);
      if (score === null) {
        continue;
      }

      const match: FileSearchMatch = {
        path: entry.path,
        kind: entry.kind,
        score,
      };

      let index = matches.findIndex(
        (candidate) => compareMatches(match, candidate) < 0,
      );
      if (index < 0) {
        matches.push(match);
      } else {
        matches.splice(index, 0, match);
      }

      if (matches.length > limit) {
        matches.pop();
      }
    }

    return matches;
  }
}
