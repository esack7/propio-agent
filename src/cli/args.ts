const CLI_FLAG_SANDBOX = "--sandbox";
const CLI_FLAG_JSON = "--json";
const CLI_FLAG_PLAIN = "--plain";
const CLI_FLAG_NO_INTERACTIVE = "--no-interactive";
const CLI_FLAG_SHOW_STATUS = "--show-status";
const CLI_FLAG_SHOW_REASONING_SUMMARY = "--show-reasoning-summary";
const CLI_FLAG_SHOW_TRACE = "--show-trace";
const CLI_FLAG_SHOW_CONTEXT_STATS = "--show-context-stats";
const CLI_FLAG_SHOW_PROMPT_PLAN = "--show-prompt-plan";
const CLI_FLAG_DEBUG_LLM = "--debug-llm";
const CLI_FLAG_DEBUG_LLM_FILE = "--debug-llm-file";
const CLI_FLAG_HELP = "--help";
const CLI_FLAG_HELP_SHORT = "-h";
const CLI_FLAG_MAX_ITERATIONS = "--max-iterations";
const CLI_FLAG_MAX_RETRIES = "--max-retries";
const CLI_FLAG_BASH_TIMEOUT_MS = "--bash-timeout-ms";
const CLI_FLAG_STREAM_IDLE_TIMEOUT_MS = "--stream-idle-timeout-ms";

export interface ParsedCliArgs {
  flags: {
    sandbox: boolean;
    json: boolean;
    plain: boolean;
    noInteractive: boolean;
    showStatus: boolean;
    showReasoningSummary: boolean;
    showContextStats: boolean;
    showPromptPlan: boolean;
    showTrace: boolean;
    debugLlm: boolean;
    debugLlmFile?: string;
    help: boolean;
    maxIterations?: number;
    maxRetries?: number;
    bashTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
  };
  forwardedArgs: string[];
  parseErrors: string[];
}

type IntFlagResult =
  | null
  | { ok: false; error: string }
  | { ok: true; value: number; consumed: boolean };

function parseIntFlag(
  arg: string,
  nextArg: string | undefined,
  flagName: string,
  min: number,
  errorMsg: string,
): IntFlagResult {
  let raw: string;
  let isSpaceForm: boolean;

  if (arg.startsWith(`${flagName}=`)) {
    raw = arg.substring(flagName.length + 1);
    isSpaceForm = false;
  } else if (arg === flagName) {
    raw = nextArg ?? "";
    isSpaceForm = true;
  } else {
    return null;
  }

  const val = parseInt(raw, 10);
  if (isNaN(val) || val < min) {
    return { ok: false, error: errorMsg };
  }
  return { ok: true, value: val, consumed: isSpaceForm };
}

type BoolFlagKeys = {
  [K in keyof ParsedCliArgs["flags"]]: ParsedCliArgs["flags"][K] extends boolean
    ? K
    : never;
}[keyof ParsedCliArgs["flags"]];

const BOOL_FLAG_MAP: ReadonlyMap<string, BoolFlagKeys> = new Map([
  [CLI_FLAG_JSON, "json"],
  [CLI_FLAG_PLAIN, "plain"],
  [CLI_FLAG_NO_INTERACTIVE, "noInteractive"],
  [CLI_FLAG_SHOW_STATUS, "showStatus"],
  [CLI_FLAG_SHOW_REASONING_SUMMARY, "showReasoningSummary"],
  [CLI_FLAG_SHOW_CONTEXT_STATS, "showContextStats"],
  [CLI_FLAG_SHOW_PROMPT_PLAN, "showPromptPlan"],
  [CLI_FLAG_SHOW_TRACE, "showTrace"],
  [CLI_FLAG_DEBUG_LLM, "debugLlm"],
  [CLI_FLAG_HELP, "help"],
  [CLI_FLAG_HELP_SHORT, "help"],
]);

type DebugLlmFileResult = { consumed: boolean } | null;

function parseDebugLlmFileArg(
  arg: string,
  nextArg: string | undefined,
  flags: ParsedCliArgs["flags"],
  forwardedArgs: string[],
  parseErrors: string[],
): DebugLlmFileResult {
  if (arg.startsWith(`${CLI_FLAG_DEBUG_LLM_FILE}=`)) {
    flags.debugLlmFile = arg.substring(CLI_FLAG_DEBUG_LLM_FILE.length + 1);
    forwardedArgs.push(arg);
    return { consumed: false };
  }

  if (arg === CLI_FLAG_DEBUG_LLM_FILE) {
    const filePath = nextArg;
    if (filePath && !filePath.startsWith("-")) {
      flags.debugLlmFile = filePath;
      forwardedArgs.push(arg, filePath);
      return { consumed: true };
    }

    parseErrors.push(
      `${CLI_FLAG_DEBUG_LLM_FILE} requires a file path argument`,
    );
    forwardedArgs.push(arg);
    return { consumed: false };
  }

  return null;
}

type IntFlagMatchResult =
  | { matched: false }
  | { matched: true; consumed: boolean };

function matchAndApplyIntFlag(
  arg: string,
  nextArg: string | undefined,
  intFlagDefs: Array<[string, number, string, (v: number) => void]>,
  parseErrors: string[],
): IntFlagMatchResult {
  for (const [flagName, min, errorMsg, setter] of intFlagDefs) {
    const result = parseIntFlag(arg, nextArg, flagName, min, errorMsg);
    if (result === null) {
      continue;
    }

    if (!result.ok) {
      parseErrors.push(result.error);
      return { matched: true, consumed: false };
    }

    setter(result.value);
    return { matched: true, consumed: result.consumed };
  }

  return { matched: false };
}

export function parseCliArgs(args: ReadonlyArray<string>): ParsedCliArgs {
  const forwardedArgs: string[] = [];
  const parseErrors: string[] = [];
  const flags: ParsedCliArgs["flags"] = {
    sandbox: false,
    json: false,
    plain: false,
    noInteractive: false,
    showStatus: false,
    showReasoningSummary: false,
    showContextStats: false,
    showPromptPlan: false,
    showTrace: false,
    debugLlm: false,
    debugLlmFile: undefined,
    help: false,
    maxIterations: undefined,
    maxRetries: undefined,
    bashTimeoutMs: undefined,
    streamIdleTimeoutMs: undefined,
  };

  const intFlagDefs: Array<[string, number, string, (v: number) => void]> = [
    [
      CLI_FLAG_MAX_ITERATIONS,
      1,
      `${CLI_FLAG_MAX_ITERATIONS} requires a positive integer`,
      (v) => {
        flags.maxIterations = v;
      },
    ],
    [
      CLI_FLAG_MAX_RETRIES,
      0,
      `${CLI_FLAG_MAX_RETRIES} requires a non-negative integer`,
      (v) => {
        flags.maxRetries = v;
      },
    ],
    [
      CLI_FLAG_BASH_TIMEOUT_MS,
      1,
      `${CLI_FLAG_BASH_TIMEOUT_MS} requires a positive integer (milliseconds)`,
      (v) => {
        flags.bashTimeoutMs = v;
      },
    ],
    [
      CLI_FLAG_STREAM_IDLE_TIMEOUT_MS,
      1,
      `${CLI_FLAG_STREAM_IDLE_TIMEOUT_MS} requires a positive integer (milliseconds)`,
      (v) => {
        flags.streamIdleTimeoutMs = v;
      },
    ],
  ];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === CLI_FLAG_SANDBOX) {
      flags.sandbox = true;
      continue;
    }

    const boolKey = BOOL_FLAG_MAP.get(arg);
    if (boolKey !== undefined) {
      flags[boolKey] = true;
      forwardedArgs.push(arg);
      continue;
    }

    const debugResult = parseDebugLlmFileArg(
      arg,
      args[i + 1],
      flags,
      forwardedArgs,
      parseErrors,
    );
    if (debugResult !== null) {
      if (debugResult.consumed) {
        i++;
      }
      continue;
    }

    const intResult = matchAndApplyIntFlag(
      arg,
      args[i + 1],
      intFlagDefs,
      parseErrors,
    );
    if (intResult.matched) {
      if (intResult.consumed) {
        i++;
      }
      forwardedArgs.push(arg);
      continue;
    }

    forwardedArgs.push(arg);
  }

  return { flags, forwardedArgs, parseErrors };
}

export function parseSandboxArgs(args: ReadonlyArray<string>): {
  sandboxRequested: boolean;
  forwardedArgs: string[];
} {
  const parsedArgs = parseCliArgs(args);
  return {
    sandboxRequested: parsedArgs.flags.sandbox,
    forwardedArgs: parsedArgs.forwardedArgs,
  };
}
