const CLI_FLAG_SANDBOX = "--sandbox";
const CLI_FLAG_JSON = "--json";
const CLI_FLAG_PLAIN = "--plain";
const CLI_FLAG_NO_INTERACTIVE = "--no-interactive";
const CLI_FLAG_SHOW_ACTIVITY = "--show-activity";
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
    showActivity: boolean;
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

export function parseCliArgs(args: ReadonlyArray<string>): ParsedCliArgs {
  const forwardedArgs: string[] = [];
  const parseErrors: string[] = [];
  const flags: ParsedCliArgs["flags"] = {
    sandbox: false,
    json: false,
    plain: false,
    noInteractive: false,
    showActivity: false,
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
    } else if (arg === CLI_FLAG_SHOW_ACTIVITY) {
      flags.showActivity = true;
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
    } else if (arg.startsWith(`${CLI_FLAG_MAX_ITERATIONS}=`)) {
      const val = parseInt(
        arg.substring(CLI_FLAG_MAX_ITERATIONS.length + 1),
        10,
      );
      if (isNaN(val) || val < 1) {
        parseErrors.push(
          `${CLI_FLAG_MAX_ITERATIONS} requires a positive integer`,
        );
      } else {
        flags.maxIterations = val;
      }
    } else if (arg === CLI_FLAG_MAX_ITERATIONS) {
      const next = args[i + 1];
      const val = next ? parseInt(next, 10) : NaN;
      if (isNaN(val) || val < 1) {
        parseErrors.push(
          `${CLI_FLAG_MAX_ITERATIONS} requires a positive integer`,
        );
      } else {
        flags.maxIterations = val;
        i++;
      }
    } else if (arg.startsWith(`${CLI_FLAG_MAX_RETRIES}=`)) {
      const val = parseInt(arg.substring(CLI_FLAG_MAX_RETRIES.length + 1), 10);
      if (isNaN(val) || val < 0) {
        parseErrors.push(
          `${CLI_FLAG_MAX_RETRIES} requires a non-negative integer`,
        );
      } else {
        flags.maxRetries = val;
      }
    } else if (arg === CLI_FLAG_MAX_RETRIES) {
      const next = args[i + 1];
      const val = next ? parseInt(next, 10) : NaN;
      if (isNaN(val) || val < 0) {
        parseErrors.push(
          `${CLI_FLAG_MAX_RETRIES} requires a non-negative integer`,
        );
      } else {
        flags.maxRetries = val;
        i++;
      }
    } else if (arg.startsWith(`${CLI_FLAG_BASH_TIMEOUT_MS}=`)) {
      const val = parseInt(
        arg.substring(CLI_FLAG_BASH_TIMEOUT_MS.length + 1),
        10,
      );
      if (isNaN(val) || val < 1) {
        parseErrors.push(
          `${CLI_FLAG_BASH_TIMEOUT_MS} requires a positive integer (milliseconds)`,
        );
      } else {
        flags.bashTimeoutMs = val;
      }
    } else if (arg === CLI_FLAG_BASH_TIMEOUT_MS) {
      const next = args[i + 1];
      const val = next ? parseInt(next, 10) : NaN;
      if (isNaN(val) || val < 1) {
        parseErrors.push(
          `${CLI_FLAG_BASH_TIMEOUT_MS} requires a positive integer (milliseconds)`,
        );
      } else {
        flags.bashTimeoutMs = val;
        i++;
      }
    } else if (arg.startsWith(`${CLI_FLAG_STREAM_IDLE_TIMEOUT_MS}=`)) {
      const val = parseInt(
        arg.substring(CLI_FLAG_STREAM_IDLE_TIMEOUT_MS.length + 1),
        10,
      );
      if (isNaN(val) || val < 1) {
        parseErrors.push(
          `${CLI_FLAG_STREAM_IDLE_TIMEOUT_MS} requires a positive integer (milliseconds)`,
        );
      } else {
        flags.streamIdleTimeoutMs = val;
      }
    } else if (arg === CLI_FLAG_STREAM_IDLE_TIMEOUT_MS) {
      const next = args[i + 1];
      const val = next ? parseInt(next, 10) : NaN;
      if (isNaN(val) || val < 1) {
        parseErrors.push(
          `${CLI_FLAG_STREAM_IDLE_TIMEOUT_MS} requires a positive integer (milliseconds)`,
        );
      } else {
        flags.streamIdleTimeoutMs = val;
        i++;
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
