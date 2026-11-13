export interface GlobalInstallClassification {
  readonly matched: boolean;
  readonly reason?: string;
}

interface ShellToken {
  readonly value: string;
  readonly quoted: boolean;
}

interface QuoteState {
  inSingleQuote: boolean;
  inDoubleQuote: boolean;
}

function createQuoteState(): QuoteState {
  return { inSingleQuote: false, inDoubleQuote: false };
}

function isOutsideQuotes(state: QuoteState): boolean {
  return !state.inSingleQuote && !state.inDoubleQuote;
}

function toggleQuoteChar(char: string, state: QuoteState): void {
  if (char === "'" && !state.inDoubleQuote) {
    state.inSingleQuote = !state.inSingleQuote;
    return;
  }

  if (char === '"' && !state.inSingleQuote) {
    state.inDoubleQuote = !state.inDoubleQuote;
  }
}

function pushSegment(segments: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    segments.push(trimmed);
  }
}

function trySplitSegment(
  char: string,
  nextChar: string | undefined,
  state: QuoteState,
  segments: string[],
  current: string,
): { current: string; skipChars: number } | null {
  if (!isOutsideQuotes(state)) {
    return null;
  }

  if (char === "|" && nextChar === "|") {
    pushSegment(segments, current);
    return { current: "", skipChars: 1 };
  }

  if (char === "&" && nextChar === "&") {
    pushSegment(segments, current);
    return { current: "", skipChars: 1 };
  }

  if (char === "|" || char === ";" || char === "\n") {
    pushSegment(segments, current);
    return { current: "", skipChars: 0 };
  }

  return null;
}

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  const quoteState = createQuoteState();

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const split = trySplitSegment(
      char,
      command[index + 1],
      quoteState,
      segments,
      current,
    );

    if (split) {
      current = split.current;
      index += split.skipChars;
      continue;
    }

    toggleQuoteChar(char, quoteState);
    current += char;
  }

  pushSegment(segments, current);
  return segments;
}

function handleQuoteToken(
  char: string,
  state: QuoteState,
  pushToken: () => void,
): boolean {
  if (char === "'" && !state.inDoubleQuote) {
    if (!state.inSingleQuote) {
      pushToken();
      state.inSingleQuote = true;
      return true;
    }

    state.inSingleQuote = false;
    pushToken();
    return true;
  }

  if (char === '"' && !state.inSingleQuote) {
    if (!state.inDoubleQuote) {
      pushToken();
      state.inDoubleQuote = true;
      return true;
    }

    state.inDoubleQuote = false;
    pushToken();
    return true;
  }

  return false;
}

function tokenizeShellSegment(segment: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let currentQuoted = false;
  const quoteState = createQuoteState();

  const pushToken = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      tokens.push({ value: trimmed, quoted: currentQuoted });
    }
    current = "";
    currentQuoted = false;
  };

  for (const char of segment) {
    if (
      !quoteState.inSingleQuote &&
      !quoteState.inDoubleQuote &&
      /\s/.test(char)
    ) {
      pushToken();
      continue;
    }

    if (handleQuoteToken(char, quoteState, pushToken)) {
      currentQuoted = quoteState.inSingleQuote || quoteState.inDoubleQuote;
      continue;
    }

    current += char;
  }

  pushToken();
  return tokens;
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

const SUDO_OPTIONS_WITH_ARGUMENT = new Set([
  "-C",
  "-D",
  "-g",
  "-G",
  "-p",
  "-R",
  "-r",
  "-t",
  "-T",
  "-U",
  "-u",
]);

const SUDO_LONG_OPTIONS_WITH_ARGUMENT = new Set([
  "--chdir",
  "--close-from",
  "--group",
  "--host",
  "--login-options",
  "--prompt",
  "--role",
  "--type",
  "--user",
]);

function isSudoOption(value: string): boolean {
  if (value.startsWith("--")) {
    return true;
  }

  return value.startsWith("-") && value.length >= 2;
}

function advancePastSudoOption(tokens: ShellToken[], index: number): number {
  const token = tokens[index];
  if (!token || token.quoted) {
    return index + 1;
  }

  const value = token.value;
  let next = index + 1;

  if (value.startsWith("--") && !value.includes("=")) {
    if (SUDO_LONG_OPTIONS_WITH_ARGUMENT.has(value)) {
      next += 1;
    }
    return next;
  }

  if (SUDO_OPTIONS_WITH_ARGUMENT.has(value)) {
    return next + 1;
  }

  return next;
}

function skipSudoWrapper(tokens: ShellToken[], index: number): number {
  let next = index + 1;
  while (next < tokens.length) {
    const option = tokens[next];
    if (!option || option.quoted || !isSudoOption(option.value)) {
      break;
    }
    next = advancePastSudoOption(tokens, next);
  }
  return next;
}

function skipEnvWrapper(tokens: ShellToken[], index: number): number {
  let next = index + 1;
  while (
    next < tokens.length &&
    !tokens[next]!.quoted &&
    isEnvAssignment(tokens[next]!.value)
  ) {
    next += 1;
  }
  return next;
}

function stripWrapperTokens(tokens: ShellToken[]): ShellToken[] {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token || token.quoted) {
      break;
    }

    if (token.value === "sudo") {
      index = skipSudoWrapper(tokens, index);
      continue;
    }

    if (token.value === "command") {
      index += 1;
      continue;
    }

    if (token.value === "env") {
      index = skipEnvWrapper(tokens, index);
      continue;
    }

    break;
  }

  return tokens.slice(index);
}

const SHELL_COMMAND_NAMES = new Set(["sh", "bash", "dash", "zsh", "ksh"]);

function isShellCommandName(command: string): boolean {
  const base = command.split("/").pop() ?? command;
  return SHELL_COMMAND_NAMES.has(base);
}

function isShellCommandFlag(token: ShellToken): boolean {
  if (token.value === "-c" || token.value === "--command") {
    return true;
  }

  return (
    !token.quoted &&
    token.value.startsWith("-") &&
    token.value.length > 2 &&
    token.value.includes("c")
  );
}

function extractShellScriptArgument(tokens: ShellToken[]): string | undefined {
  const first = tokens[0];
  if (!first || first.quoted || !isShellCommandName(first.value)) {
    return undefined;
  }

  const args = tokens.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token || !isShellCommandFlag(token)) {
      continue;
    }

    return args[index + 1]?.value;
  }

  return undefined;
}

function hasGlobalNpmFlag(tokens: string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-g" || token === "--global") {
      return true;
    }
    if (
      token === "--location=global" ||
      token.startsWith("--location=global")
    ) {
      return true;
    }
    if (token === "--location" && tokens[index + 1] === "global") {
      return true;
    }
  }

  return false;
}

function hasInstallVerb(tokens: string[]): boolean {
  return tokens.some((token) => token === "install" || token === "i");
}

function hasAddVerb(tokens: string[]): boolean {
  return tokens.some((token) => token === "add" || token === "install");
}

const APT_FAMILY = new Set(["apt", "apt-get", "dnf", "yum"]);

type InstallMatcher = {
  readonly matches: (command: string, rest: string[]) => boolean;
  readonly reason: string | ((command: string) => string);
};

const GLOBAL_INSTALL_MATCHERS: readonly InstallMatcher[] = [
  {
    matches: (command, rest) =>
      command === "npm" && hasInstallVerb(rest) && hasGlobalNpmFlag(rest),
    reason: "This command would install software globally via npm.",
  },
  {
    matches: (command, rest) =>
      command === "pnpm" && hasAddVerb(rest) && hasGlobalNpmFlag(rest),
    reason: "This command would install software globally via pnpm.",
  },
  {
    matches: (command, rest) =>
      command === "yarn" && rest.includes("global") && rest.includes("add"),
    reason: "This command would install software globally via yarn.",
  },
  {
    matches: (command, rest) =>
      command === "brew" &&
      (rest.includes("install") || rest.includes("upgrade")),
    reason:
      "This command would install or upgrade software globally via Homebrew.",
  },
  {
    matches: (command, rest) =>
      APT_FAMILY.has(command) && rest.includes("install"),
    reason: (command) =>
      `This command would install software globally via ${command}.`,
  },
  {
    matches: (command, rest) => command === "apk" && rest.includes("add"),
    reason: "This command would install software globally via apk.",
  },
  {
    matches: (command, rest) =>
      command === "pacman" && rest.some((token) => token.startsWith("-S")),
    reason: "This command would install software globally via pacman.",
  },
  {
    matches: (command, rest) =>
      command === "zypper" && rest.includes("install"),
    reason: "This command would install software globally via zypper.",
  },
  {
    matches: (command, rest) => command === "pipx" && rest.includes("install"),
    reason: "This command would install software globally via pipx.",
  },
  {
    matches: (command, rest) => command === "cargo" && rest.includes("install"),
    reason: "This command would install software globally via cargo.",
  },
  {
    matches: (command, rest) => command === "gem" && rest.includes("install"),
    reason: "This command would install software globally via gem.",
  },
];

function matchGlobalInstall(tokens: string[]): GlobalInstallClassification {
  if (tokens.length === 0) {
    return { matched: false };
  }

  const [command, ...rest] = tokens;
  for (const matcher of GLOBAL_INSTALL_MATCHERS) {
    if (!matcher.matches(command, rest)) {
      continue;
    }

    return {
      matched: true,
      reason:
        typeof matcher.reason === "function"
          ? matcher.reason(command)
          : matcher.reason,
    };
  }

  return { matched: false };
}

const MAX_CLASSIFICATION_DEPTH = 4;

function classifySegmentTokens(
  tokens: ShellToken[],
  depth: number,
): GlobalInstallClassification {
  const stripped = stripWrapperTokens(tokens);
  const shellScript = extractShellScriptArgument(stripped);
  if (shellScript) {
    return classifyGlobalInstallCommand(shellScript, depth + 1);
  }

  const unquoted = stripped
    .filter((token) => !token.quoted)
    .map((token) => token.value);
  return matchGlobalInstall(unquoted);
}

export function classifyGlobalInstallCommand(
  command: string,
  depth = 0,
): GlobalInstallClassification {
  if (depth > MAX_CLASSIFICATION_DEPTH) {
    return { matched: false };
  }

  for (const segment of splitCommandSegments(command)) {
    const result = classifySegmentTokens(tokenizeShellSegment(segment), depth);
    if (result.matched) {
      return result;
    }
  }

  return { matched: false };
}

/** The only spellings read as a global install; npm reads each the same way. */
const GLOBAL_SCOPE_OPTIONS: ReadonlySet<string> = new Set([
  "-g",
  "--global",
  "--location=global",
]);

/**
 * Whether an npm or pnpm argument list is, beyond doubt, a global install
 * with one of `verbs`. npm's option parser reads options in order, takes a
 * separate `true` or `false` as a boolean option's value, expands
 * abbreviations (`--no-glob`), and stops at `--`, so a list is accepted only
 * when every argument is the subcommand, a global option spelled exactly as
 * above, `--location global`, `--`, or a package. Any other option, and a
 * bare `true` or `false`, sends the call to the operator.
 */
function isAllowlistedGlobalInstall(
  args: readonly ShellToken[],
  verbs: readonly string[],
): boolean {
  let global = false;
  let endOfOptions = false;
  const positionals: Array<{ token: ShellToken; afterEnd: boolean }> = [];
  for (let index = 0; index < args.length;) {
    const { kind, span } = readArgument(args, index, endOfOptions);
    if (kind === "reject") return false;
    if (kind === "end") endOfOptions = true;
    if (kind === "global") global = true;
    if (kind === "positional") {
      positionals.push({ token: args[index]!, afterEnd: endOfOptions });
    }
    index += span;
  }
  return global && isInstallSubcommand(positionals[0], verbs);
}

/**
 * The first positional is the subcommand; after `--` npm would read it as a
 * package instead, and a quoted one is not taken at its word.
 */
function isInstallSubcommand(
  first: { token: ShellToken; afterEnd: boolean } | undefined,
  verbs: readonly string[],
): boolean {
  return (
    first !== undefined &&
    !first.afterEnd &&
    !first.token.quoted &&
    verbs.includes(first.token.value)
  );
}

type ArgumentKind = "end" | "global" | "positional" | "reject";

/** What the argument at `index` is, and how many arguments it spans. */
function readArgument(
  args: readonly ShellToken[],
  index: number,
  endOfOptions: boolean,
): { kind: ArgumentKind; span: number } {
  const value = args[index]!.value;
  if (!endOfOptions && value === "--") return { kind: "end", span: 1 };
  if (!endOfOptions && value.startsWith("-")) {
    const span = globalOptionLength(args, index);
    return span > 0 ? { kind: "global", span } : { kind: "reject", span: 1 };
  }
  return { kind: isPlainPositional(value) ? "positional" : "reject", span: 1 };
}

/** How many arguments a global option at `index` spans; 0 if it is not one. */
function globalOptionLength(
  args: readonly ShellToken[],
  index: number,
): number {
  const value = args[index]!.value;
  if (GLOBAL_SCOPE_OPTIONS.has(value)) return 1;
  return value === "--location" && args[index + 1]?.value === "global" ? 2 : 0;
}

/** A bare `true` or `false` may be the value of the option before it. */
function isPlainPositional(value: string): boolean {
  return value !== "true" && value !== "false";
}

/**
 * The subcommand that installs, for package managers whose syntax makes it
 * unambiguous. A manager not listed here (pacman's -S family, for one) is
 * never recognized.
 */
const INSTALL_SUBCOMMANDS: Readonly<
  Record<
    string,
    { readonly verbs: readonly string[]; readonly global?: boolean }
  >
> = {
  npm: { verbs: ["install", "i", "add"], global: true },
  pnpm: { verbs: ["add"], global: true },
  brew: { verbs: ["install", "upgrade"] },
  apt: { verbs: ["install"] },
  "apt-get": { verbs: ["install"] },
  dnf: { verbs: ["install"] },
  yum: { verbs: ["install"] },
  apk: { verbs: ["add"] },
  zypper: { verbs: ["install"] },
  pipx: { verbs: ["install"] },
  cargo: { verbs: ["install"] },
  gem: { verbs: ["install"] },
};

/**
 * Whether a command is, beyond doubt, one package manager installing
 * globally: a single command with no wrapper (`sudo`, `env`, a shell) whose
 * first word after the manager's own options is its install subcommand.
 * `classifyGlobalInstallCommand` flags likely installs for review; this
 * stricter test decides what a blanket approval may cover, so any doubt
 * answers no.
 */
export function isUnambiguousGlobalInstall(command: string): boolean {
  const segments = splitCommandSegments(command);
  if (segments.length !== 1) return false;
  const tokens = tokenizeShellSegment(segments[0]!);
  const [manager, ...rest] = tokens;
  if (!manager || manager.quoted) return false;
  const words = rest.map((token) => token.value);
  if (manager.value === "yarn") {
    const [first, second] = words.filter((word) => !word.startsWith("-"));
    return first === "global" && second === "add";
  }
  const known = Object.prototype.hasOwnProperty.call(
    INSTALL_SUBCOMMANDS,
    manager.value,
  )
    ? INSTALL_SUBCOMMANDS[manager.value]
    : undefined;
  if (!known) return false;
  if (known.global) return isAllowlistedGlobalInstall(rest, known.verbs);
  const subcommand = rest.find((token) => !token.value.startsWith("-"));
  return (
    subcommand !== undefined &&
    !subcommand.quoted &&
    known.verbs.includes(subcommand.value)
  );
}
