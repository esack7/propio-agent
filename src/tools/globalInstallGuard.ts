export interface GlobalInstallApprovalRequest {
  readonly command: string;
  readonly reason: string;
}

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

export const GLOBAL_INSTALL_DENIED_MESSAGE =
  "Global software install blocked. Set PROPIO_ALLOW_GLOBAL_INSTALLS=1 or approve the install in interactive mode.";
