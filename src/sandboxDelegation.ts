import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { parseCliArgs } from "./cli/args.js";
import { formatError } from "./ui/formatting.js";

const SANDBOX_SIGNAL_EXIT_CODE = 1;

export type SpawnProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd: string;
    shell: false;
    stdio: "inherit";
  },
) => ChildProcess;

export interface SandboxDelegationDeps {
  resolveWrapperPath: () => string;
  validateWrapper: (wrapperPath: string) => void;
  spawnProcess: SpawnProcess;
  logError: (message: string) => void;
}

export function resolveSandboxWrapperPath(entryModuleUrl: string): string {
  const entryFilePath = fileURLToPath(entryModuleUrl);
  const entryDir = path.dirname(entryFilePath);
  const repoRoot = path.resolve(entryDir, "..");
  return path.resolve(repoRoot, "bin", "propio-sandbox");
}

function defaultLogError(message: string): void {
  process.stderr.write(formatError(`${message}\n`));
}

export function validateSandboxWrapper(wrapperPath: string): void {
  if (!fs.existsSync(wrapperPath)) {
    throw new Error(`Sandbox wrapper not found at ${wrapperPath}.`);
  }

  try {
    fs.accessSync(wrapperPath, fs.constants.X_OK);
  } catch {
    throw new Error(`Sandbox wrapper is not executable: ${wrapperPath}.`);
  }
}

function createDefaultSandboxDeps(): SandboxDelegationDeps {
  return {
    resolveWrapperPath: () => resolveSandboxWrapperPath(import.meta.url),
    validateWrapper: validateSandboxWrapper,
    spawnProcess: spawn as SpawnProcess,
    logError: defaultLogError,
  };
}

function runDelegatedSandboxProcess(
  wrapperPath: string,
  forwardedArgs: ReadonlyArray<string>,
  deps: SandboxDelegationDeps,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = deps.spawnProcess(wrapperPath, [...forwardedArgs], {
      cwd: process.cwd(),
      shell: false,
      stdio: "inherit",
    });

    child.once("error", (error: Error) => {
      deps.logError(
        `Failed to start sandbox wrapper (${wrapperPath}): ${error.message}`,
      );
      resolve(1);
    });

    child.once(
      "close",
      (code: number | null, signal: NodeJS.Signals | null) => {
        if (typeof code === "number") {
          resolve(code);
          return;
        }

        if (signal) {
          deps.logError(`Sandbox wrapper exited due to signal: ${signal}`);
        }
        resolve(SANDBOX_SIGNAL_EXIT_CODE);
      },
    );
  });
}

export async function maybeRunSandboxDelegation(
  args: ReadonlyArray<string>,
  overrides: Partial<SandboxDelegationDeps> = {},
): Promise<number | null> {
  const { flags, forwardedArgs } = parseCliArgs(args);
  if (!flags.sandbox) {
    return null;
  }

  const deps: SandboxDelegationDeps = {
    ...createDefaultSandboxDeps(),
    ...overrides,
  };
  const wrapperPath = deps.resolveWrapperPath();

  try {
    deps.validateWrapper(wrapperPath);
  } catch (error) {
    deps.logError(
      error instanceof Error
        ? error.message
        : "Unable to validate sandbox wrapper.",
    );
    return 1;
  }

  return runDelegatedSandboxProcess(wrapperPath, forwardedArgs, deps);
}
