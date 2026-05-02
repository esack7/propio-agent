import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export type FileSearchEntryKind = "file" | "directory";

export interface FileSearchEntry {
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

function createEntries(
  paths: readonly string[],
  workspaceRoot: string,
): FileSearchEntry[] {
  const seen = new Set<string>();
  const entries: FileSearchEntry[] = [];

  for (const absoluteOrRelative of paths) {
    const absolutePath = path.isAbsolute(absoluteOrRelative)
      ? absoluteOrRelative
      : path.resolve(workspaceRoot, absoluteOrRelative);
    const relativePath = toWorkspaceRelative(absolutePath, workspaceRoot);
    if (!relativePath || shouldIgnorePath(relativePath)) {
      continue;
    }

    if (!seen.has(relativePath)) {
      seen.add(relativePath);
      entries.push({
        path: relativePath,
        lowerPath: relativePath.toLowerCase(),
        kind: "file",
      });
    }

    for (const directoryPrefix of collectDirectoryPrefixes(relativePath)) {
      if (shouldIgnorePath(directoryPrefix)) {
        continue;
      }
      if (seen.has(directoryPrefix)) {
        continue;
      }
      seen.add(directoryPrefix);
      entries.push({
        path: directoryPrefix,
        lowerPath: directoryPrefix.toLowerCase(),
        kind: "directory",
      });
    }
  }

  return entries;
}

function runCommand(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
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
    child.once("error", reject);
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

function scoreCandidate(entry: FileSearchEntry, query: string): number | null {
  if (query.length === 0) {
    return (
      countPathDepth(entry.path) + (entry.kind === "directory" ? -0.25 : 0)
    );
  }

  const caseSensitive = /[A-Z]/.test(query);
  const needle = caseSensitive ? query : query.toLowerCase();
  const haystack = caseSensitive ? entry.path : entry.lowerPath;

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
    } else if (isBoundaryCharacter(entry.path[index - 1])) {
      score -= 2;
    }

    previousIndex = index;
  }

  const normalizedPath =
    entry.kind === "directory" ? entry.path.slice(0, -1) : entry.path;
  const basename = path.basename(normalizedPath);
  const normalizedNeedle = caseSensitive ? query : query.toLowerCase();
  const normalizedBasename = caseSensitive ? basename : basename.toLowerCase();

  if (normalizedBasename.startsWith(normalizedNeedle)) {
    score -= 3;
  }

  if (entry.lowerPath.includes("test")) {
    score += 0.35;
  }

  score += entry.path.length * 0.04;
  if (entry.kind === "directory") {
    score -= 0.1;
  }

  return score;
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

    return [];
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

  getEntries(): readonly FileSearchEntry[] {
    return this.entries;
  }

  search(query: string, limit = 20): FileSearchMatch[] {
    const trimmedQuery = query.trim();
    if (this.entries.length === 0) {
      void this.refresh(true);
      return [];
    }

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
