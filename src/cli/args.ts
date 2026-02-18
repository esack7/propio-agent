export const CLI_FLAG_SANDBOX = "--sandbox";
export const CLI_FLAG_JSON = "--json";
export const CLI_FLAG_PLAIN = "--plain";
export const CLI_FLAG_NO_INTERACTIVE = "--no-interactive";
export const CLI_FLAG_DEBUG_LLM = "--debug-llm";
export const CLI_FLAG_DEBUG_LLM_FILE = "--debug-llm-file";
export const CLI_FLAG_HELP = "--help";
export const CLI_FLAG_HELP_SHORT = "-h";

export interface ParsedCliArgs {
  flags: {
    sandbox: boolean;
    json: boolean;
    plain: boolean;
    noInteractive: boolean;
    debugLlm: boolean;
    debugLlmFile?: string;
    help: boolean;
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
    debugLlm: false,
    debugLlmFile: undefined,
    help: false,
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
