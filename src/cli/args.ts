export const CLI_FLAG_SANDBOX = "--sandbox";

export interface ParsedCliArgs {
  flags: {
    sandbox: boolean;
  };
  forwardedArgs: string[];
}

export function parseCliArgs(args: ReadonlyArray<string>): ParsedCliArgs {
  const forwardedArgs: string[] = [];
  const flags = {
    sandbox: false,
  };

  for (const arg of args) {
    if (arg === CLI_FLAG_SANDBOX) {
      flags.sandbox = true;
      continue;
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
