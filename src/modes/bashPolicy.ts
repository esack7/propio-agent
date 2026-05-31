import type { AgentMode } from "./types.js";

export interface BashPolicyResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

const SINGLE_TOKEN_DENIES = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "truncate",
  "chmod",
  "chown",
  "install",
]);

const GIT_MUTATING_SUBCOMMANDS = new Set([
  "checkout",
  "reset",
  "clean",
  "revert",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "switch",
  "restore",
  "add",
  "rm",
  "stash",
]);

const GIT_WORKTREE_MUTATORS = new Set(["add", "remove", "prune"]);

const GIT_GLOBAL_OPTIONS_WITH_ARG = new Set([
  "-C",
  "-c",
  "--exec-path",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

const GIT_TAG_LIST_FLAGS = new Set(["-l", "-n", "--list"]);

const PACKAGE_INSTALL_SEQUENCES: readonly (readonly string[])[] = [
  ["npm", "install"],
  ["npm", "i"],
  ["pnpm", "install"],
  ["pnpm", "add"],
  ["yarn", "add"],
  ["yarn", "install"],
  ["pip", "install"],
  ["pip3", "install"],
  ["cargo", "install"],
  ["go", "install"],
];

const NULL_REDIRECT_TARGETS = new Set(["/dev/null", "nul"]);

function isNullRedirectTarget(target: string): boolean {
  const trimmed = target.trim();
  return NULL_REDIRECT_TARGETS.has(trimmed);
}

function normalizeSedFlagToken(token: string): string {
  if (!token.startsWith("-")) {
    return token;
  }
  const letters = token.slice(1).replace(/[^a-zA-Z]/g, "");
  return letters.split("").sort().join("");
}

function tokenHasInPlaceSedFlag(token: string): boolean {
  if (!token.startsWith("-")) {
    return false;
  }
  const normalized = normalizeSedFlagToken(token);
  return normalized.includes("i");
}

function pushSegment(segments: string[], segment: string): void {
  const trimmed = segment.trim();
  if (trimmed.length > 0) {
    segments.push(trimmed);
  }
}

type ShellQuote = "'" | '"' | null;

interface ShellScanState {
  quote: ShellQuote;
  escaped: boolean;
}

function consumeEscapedShellChar(
  ch: string,
  state: ShellScanState,
  append: (value: string) => void,
): boolean {
  if (!state.escaped) return false;
  append(ch);
  state.escaped = false;
  return true;
}

function consumeEscapeStart(
  ch: string,
  state: ShellScanState,
  append: (value: string) => void,
  keepEscape: boolean,
): boolean {
  if (ch !== "\\" || state.quote === "'") return false;
  state.escaped = true;
  if (keepEscape) {
    append(ch);
  }
  return true;
}

function consumeQuotedShellChar(
  ch: string,
  state: ShellScanState,
  append: (value: string) => void,
  keepQuotes: boolean,
): boolean {
  if (!state.quote) return false;
  if (ch !== state.quote) {
    append(ch);
    return true;
  }

  state.quote = null;
  if (keepQuotes) {
    append(ch);
  }
  return true;
}

function consumeQuoteStart(
  ch: string,
  state: ShellScanState,
  append: (value: string) => void,
  keepQuotes: boolean,
): boolean {
  if (ch !== "'" && ch !== '"') return false;
  state.quote = ch;
  if (keepQuotes) {
    append(ch);
  }
  return true;
}

function consumeShellQuoteSyntax(
  ch: string,
  state: ShellScanState,
  append: (value: string) => void,
  options: { keepEscape: boolean; keepQuotes: boolean },
): boolean {
  return (
    consumeEscapedShellChar(ch, state, append) ||
    consumeEscapeStart(ch, state, append, options.keepEscape) ||
    consumeQuotedShellChar(ch, state, append, options.keepQuotes) ||
    consumeQuoteStart(ch, state, append, options.keepQuotes)
  );
}

function consumeSplitQuoteSyntax(
  ch: string,
  state: ShellScanState,
  append: (value: string) => void,
): boolean {
  return consumeShellQuoteSyntax(ch, state, append, {
    keepEscape: true,
    keepQuotes: true,
  });
}

function consumeTokenQuoteSyntax(
  ch: string,
  state: ShellScanState,
  append: (value: string) => void,
): boolean {
  return consumeShellQuoteSyntax(ch, state, append, {
    keepEscape: false,
    keepQuotes: false,
  });
}

/**
 * Split a shell command into segments at command boundaries (;, &&, ||, |).
 * Quote-aware; does not split inside '…' or "…".
 */
export function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  const state: ShellScanState = { quote: null, escaped: false };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (consumeSplitQuoteSyntax(ch, state, (value) => (current += value))) {
      continue;
    }

    if (command.startsWith("&&", i)) {
      pushSegment(segments, current);
      current = "";
      i++;
      continue;
    }

    if (command.startsWith("||", i)) {
      pushSegment(segments, current);
      current = "";
      i++;
      continue;
    }

    if (ch === ";") {
      pushSegment(segments, current);
      current = "";
      continue;
    }

    if (ch === "|") {
      const prev = current.slice(-1);
      if (prev === ">" || prev === "|") {
        current += ch;
        continue;
      }
      pushSegment(segments, current);
      current = "";
      continue;
    }

    current += ch;
  }

  pushSegment(segments, current);
  return segments;
}

export function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  const state: ShellScanState = { quote: null, escaped: false };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (consumeTokenQuoteSyntax(ch, state, (value) => (current += value))) {
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function indexAfterGitGlobalOptions(
  tokens: readonly string[],
  start: number,
): number {
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (!token.startsWith("-")) {
      return i;
    }

    if (token.includes("=")) {
      i++;
      continue;
    }

    if (GIT_GLOBAL_OPTIONS_WITH_ARG.has(token)) {
      i += 2;
      continue;
    }

    i++;
  }

  return i;
}

function matchesSequence(
  tokens: readonly string[],
  start: number,
  sequence: readonly string[],
): boolean {
  if (start + sequence.length > tokens.length) {
    return false;
  }
  return sequence.every((part, index) => tokens[start + index] === part);
}

function isOutputRedirectToken(token: string): boolean {
  if (token === ">" || token === ">>") {
    return true;
  }
  if (/^(\d)?>>?$/.test(token) && token !== "2>&1") {
    return true;
  }
  if (/^\d>>$/.test(token)) {
    return true;
  }
  return false;
}

function isAllowedStderrRedirect(token: string, nextToken?: string): boolean {
  if (token === "2>&1") {
    return true;
  }
  if (token === "2>/dev/null" || token === "2>nul") {
    return true;
  }
  if (token === "2>" && nextToken && isNullRedirectTarget(nextToken)) {
    return true;
  }
  if (token === ">/dev/null" || token === ">&/dev/null") {
    return true;
  }
  return false;
}

// fallow-ignore-next-line complexity
function checkRedirectTokens(
  tokens: readonly string[],
): BashPolicyResult | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1];

    if (isAllowedStderrRedirect(token, next)) {
      if (token === "2>" && next) {
        i++;
      }
      continue;
    }

    if (token.includes(">") && !token.includes("<")) {
      if (token.endsWith("/dev/null") || token.endsWith("nul")) {
        continue;
      }
      if (isOutputRedirectToken(token)) {
        if (next && isNullRedirectTarget(next)) {
          i++;
          continue;
        }
        return {
          allowed: false,
          reason: `Output redirection to a file is not allowed in this mode (${token}${next ? ` ${next}` : ""})`,
        };
      }
      if (/^[^=]*>[^=]*$/.test(token)) {
        const target = token.split(">").pop() ?? "";
        if (!isNullRedirectTarget(target)) {
          return {
            allowed: false,
            reason: `Output redirection is not allowed in this mode (${token})`,
          };
        }
      }
    }
  }

  return null;
}

function hasGitTagMutatingFlag(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "-d" ||
      arg === "-f" ||
      arg === "-a" ||
      arg === "-m" ||
      arg === "--delete",
  );
}

function checkGitTagInvocation(
  tokens: readonly string[],
): BashPolicyResult | null {
  const gitIndex = tokens.indexOf("git");
  if (gitIndex === -1) {
    return null;
  }

  const tagIndex = indexAfterGitGlobalOptions(tokens, gitIndex + 1);
  if (tagIndex >= tokens.length || tokens[tagIndex] !== "tag") {
    return null;
  }

  const args = tokens.slice(tagIndex + 1);
  if (args.length === 0) {
    return null;
  }

  const hasListFlag = args.some(
    (arg) => GIT_TAG_LIST_FLAGS.has(arg) || arg.startsWith("--list"),
  );
  if (hasListFlag) {
    if (hasGitTagMutatingFlag(args)) {
      return {
        allowed: false,
        reason: "git tag create/update/delete is not allowed in this mode",
      };
    }
    return null;
  }

  if (hasGitTagMutatingFlag(args)) {
    return {
      allowed: false,
      reason: "git tag create/update/delete is not allowed in this mode",
    };
  }

  const hasPositionalTagName = args.some((arg) => !arg.startsWith("-"));
  if (hasPositionalTagName) {
    return {
      allowed: false,
      reason: "git tag create/update/delete is not allowed in this mode",
    };
  }

  return null;
}

// fallow-ignore-next-line complexity
function checkGitInvocation(
  tokens: readonly string[],
  gitIndex: number,
): BashPolicyResult | null {
  const subIndex = indexAfterGitGlobalOptions(tokens, gitIndex + 1);
  if (subIndex >= tokens.length) {
    return null;
  }

  const sub = tokens[subIndex]!;

  if (sub === "tag") {
    return checkGitTagInvocation(tokens);
  }

  if (GIT_MUTATING_SUBCOMMANDS.has(sub)) {
    if (sub === "stash") {
      const stashOp = tokens[subIndex + 1];
      if (stashOp !== "list") {
        return {
          allowed: false,
          reason: `git ${sub} is not allowed in this mode`,
        };
      }
    } else if (sub !== "branch" && sub !== "worktree") {
      return {
        allowed: false,
        reason: `git ${sub} is not allowed in this mode`,
      };
    }
  }

  if (sub === "branch") {
    const branchArgs = tokens.slice(subIndex + 1);
    if (branchArgs.includes("-d") || branchArgs.includes("-D")) {
      return {
        allowed: false,
        reason: "git branch delete is not allowed in this mode",
      };
    }
  }

  if (sub === "worktree") {
    const worktreeOp = tokens[subIndex + 1];
    if (worktreeOp && GIT_WORKTREE_MUTATORS.has(worktreeOp)) {
      return {
        allowed: false,
        reason: `git worktree ${worktreeOp} is not allowed in this mode`,
      };
    }
  }

  return null;
}

// fallow-ignore-next-line complexity
function checkTokenSequences(
  tokens: readonly string[],
): BashPolicyResult | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (SINGLE_TOKEN_DENIES.has(token)) {
      return {
        allowed: false,
        reason: `Command "${token}" is not allowed in this mode`,
      };
    }

    if (token === "sed" && i + 1 < tokens.length) {
      const next = tokens[i + 1]!;
      if (tokenHasInPlaceSedFlag(next)) {
        return {
          allowed: false,
          reason: "sed in-place editing is not allowed in this mode",
        };
      }
    }

    if (token === "perl" && i + 1 < tokens.length && tokens[i + 1] === "-pi") {
      return {
        allowed: false,
        reason: "perl in-place editing is not allowed in this mode",
      };
    }

    if (token === "git") {
      const gitDeny = checkGitInvocation(tokens, i);
      if (gitDeny) {
        return gitDeny;
      }
    }

    for (const sequence of PACKAGE_INSTALL_SEQUENCES) {
      if (matchesSequence(tokens, i, sequence)) {
        return {
          allowed: false,
          reason: `${sequence.join(" ")} is not allowed in this mode`,
        };
      }
    }
  }

  return null;
}

function checkSegmentPolicy(segment: string): BashPolicyResult | null {
  const tokens = tokenizeShellCommand(segment.trim());
  if (tokens.length === 0) {
    return null;
  }

  const redirectDeny = checkRedirectTokens(tokens);
  if (redirectDeny) {
    return redirectDeny;
  }

  return checkTokenSequences(tokens);
}

export function checkBashAllowedForMode(
  command: string,
  mode: AgentMode,
): BashPolicyResult {
  if (mode === "execute") {
    return { allowed: true };
  }

  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { allowed: true };
  }

  const segments = splitShellCommandSegments(trimmed);
  for (const segment of segments) {
    const deny = checkSegmentPolicy(segment);
    if (deny) {
      return deny;
    }
  }

  return { allowed: true };
}
