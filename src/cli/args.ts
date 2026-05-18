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

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === CLI_FLAG_SANDBOX) {
      flags.sandbox = true;
      continue;
    }
    if (arg === CLI_FLAG_JSON) {
      flags.json = true;
    } else if (arg === CLI_FLAG_PLAIN) {
      flags.plain = true;
    } else if (arg === CLI_FLAG_NO_INTERACTIVE) {
      flags.noInteractive = true;
    } else if (arg === CLI_FLAG_SHOW_STATUS) {
      flags.showStatus = true;
    } else if (arg === CLI_FLAG_SHOW_REASONING_SUMMARY) {
      flags.showReasoningSummary = true;
    } else if (arg === CLI_FLAG_SHOW_CONTEXT_STATS) {
      flags.showContextStats = true;
    } else if (arg === CLI_FLAG_SHOW_PROMPT_PLAN) {
      flags.showPromptPlan = true;
    } else if (arg === CLI_FLAG_SHOW_TRACE) {
      flags.showTrace = true;
    } else if (arg === CLI_FLAG_DEBUG_LLM) {
      flags.debugLlm = true;
    } else if (arg.startsWith(`${CLI_FLAG_DEBUG_LLM_FILE}=`)) {
      flags.debugLlmFile = arg.substring(CLI_FLAG_DEBUG_LLM_FILE.length + 1);
    } else if (arg === CLI_FLAG_DEBUG_LLM_FILE) {
      const filePath = args[i + 1];
      if (filePath && !filePath.startsWith("-")) {
        flags.debugLlmFile = filePath;
        forwardedArgs.push(arg);
        forwardedArgs.push(filePath);
        i++;
        continue;
      } else {
        parseErrors.push(
          `${CLI_FLAG_DEBUG_LLM_FILE} requires a file path argument`,
        );
      }
    } else if (arg === CLI_FLAG_HELP || arg === CLI_FLAG_HELP_SHORT) {
      flags.help = true;
    } else {
      const next = args[i + 1];
      const intFlagDefs: Array<[string, number, string, (v: number) => void]> =
        [
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

      let matched = false;
      for (const [flagName, min, errorMsg, setter] of intFlagDefs) {
        const result = parseIntFlag(arg, next, flagName, min, errorMsg);
        if (result === null) continue;
        matched = true;
        if (!result.ok) {
          parseErrors.push(result.error);
        } else {
          setter(result.value);
          if (result.consumed) i++;
        }
        break;
      }

      if (matched) {
        forwardedArgs.push(arg);
        continue;
      }
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
