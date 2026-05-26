import { execSync } from "child_process";
import * as os from "os";
import * as path from "path";

export const SYSTEM_PROMPT_ENV_MAX_CHARS = 2000;
const GIT_CACHE_TTL_MS = 5000;
const GIT_PROBE_TIMEOUT_MS = 150;

export interface SystemPromptContext {
  os: string;
  cwd: string;
  dateTime: string;
  nodeVersion: string;
  shell: string;
  gitBranch?: string;
  isGitDirty?: boolean;
  enabledToolNames: readonly string[];
  scratchpadDir?: string;
}

export interface BuildSystemPromptContextOptions {
  cwd?: string;
  enabledToolNames?: readonly string[];
  scratchpadDir?: string;
}

interface GitCacheEntry {
  cwd: string;
  branch?: string;
  isDirty?: boolean;
  fetchedAt: number;
}

const gitCacheByCwd = new Map<string, GitCacheEntry>();

function formatOs(): string {
  return `${os.type()} ${os.release()} (${process.platform} ${os.arch()})`;
}

function formatDateTime(): string {
  const now = new Date();
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const mins = String(abs % 60).padStart(2, "0");
  const tz = `UTC${sign}${hours}:${mins}`;
  return `${now.toISOString()} (${tz})`;
}

function probeGitSync(cwd: string): { branch?: string; isDirty?: boolean } {
  const deadline = Date.now() + GIT_PROBE_TIMEOUT_MS;
  const remainingMs = (): number => Math.max(0, deadline - Date.now());

  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: remainingMs(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (remainingMs() === 0) {
      return { branch: branch || undefined };
    }
    const status = execSync("git status --porcelain", {
      cwd,
      encoding: "utf-8",
      timeout: remainingMs(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    return {
      branch: branch || undefined,
      isDirty: status.trim().length > 0,
    };
  } catch {
    return {};
  }
}

function resolveGitState(cwd: string): {
  gitBranch?: string;
  isGitDirty?: boolean;
} {
  const resolvedCwd = path.resolve(cwd);
  const now = Date.now();
  const cached = gitCacheByCwd.get(resolvedCwd);
  if (cached && now - cached.fetchedAt < GIT_CACHE_TTL_MS) {
    return {
      gitBranch: cached.branch,
      isGitDirty: cached.isDirty,
    };
  }

  const git = probeGitSync(resolvedCwd);
  gitCacheByCwd.set(resolvedCwd, {
    cwd: resolvedCwd,
    branch: git.branch,
    isDirty: git.isDirty,
    fetchedAt: now,
  });

  return {
    gitBranch: git.branch,
    isGitDirty: git.isDirty,
  };
}

/** Reset git cache (for tests). */
export function resetGitCacheForTests(): void {
  gitCacheByCwd.clear();
}

/** Seed git cache for a cwd (for tests). */
export function seedGitCacheForTests(
  cwd: string,
  state: { branch?: string; isDirty?: boolean },
): void {
  const resolvedCwd = path.resolve(cwd);
  gitCacheByCwd.set(resolvedCwd, {
    cwd: resolvedCwd,
    branch: state.branch,
    isDirty: state.isDirty,
    fetchedAt: Date.now(),
  });
}

export function buildSystemPromptContext(
  options: BuildSystemPromptContextOptions = {},
): SystemPromptContext {
  const cwd = options.cwd ?? process.cwd();
  const git = resolveGitState(cwd);

  return {
    os: formatOs(),
    cwd,
    dateTime: formatDateTime(),
    nodeVersion: process.version,
    shell: process.env.SHELL || "(unknown)",
    gitBranch: git.gitBranch,
    isGitDirty: git.isGitDirty,
    enabledToolNames: options.enabledToolNames ?? [],
    scratchpadDir: options.scratchpadDir,
  };
}

/** Context without git probes (for default export snapshot). */
export function buildEmptySystemPromptContext(
  options: BuildSystemPromptContextOptions = {},
): SystemPromptContext {
  return {
    os: formatOs(),
    cwd: options.cwd ?? process.cwd(),
    dateTime: formatDateTime(),
    nodeVersion: process.version,
    shell: process.env.SHELL || "(unknown)",
    enabledToolNames: options.enabledToolNames ?? [],
  };
}
