export const CLI_FLAG_SANDBOX = "--sandbox";
export const CLI_FLAG_JSON = "--json";
export const CLI_FLAG_PLAIN = "--plain";
export const CLI_FLAG_NO_INTERACTIVE = "--no-interactive";
export const CLI_FLAG_HELP = "--help";
export const CLI_FLAG_HELP_SHORT = "-h";

export interface ParsedCliArgs {
  flags: {
    sandbox: boolean;
    json: boolean;
    plain: boolean;
    noInteractive: boolean;
    help: boolean;
  };
  forwardedArgs: string[];
}

export function parseCliArgs(args: ReadonlyArray<string>): ParsedCliArgs {
  const forwardedArgs: string[] = [];
  const flags = {
    sandbox: false,
    json: false,
    plain: false,
    noInteractive: false,
    help: false,
  };

  for (const arg of args) {
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
    } else if (arg === CLI_FLAG_HELP || arg === CLI_FLAG_HELP_SHORT) {
      flags.help = true;
    }

    forwardedArgs.push(arg);
  }

  return { flags, forwardedArgs };
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
