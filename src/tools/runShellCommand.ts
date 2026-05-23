import { execFile, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MESSAGE = "Command timed out and was killed";
const CANCEL_MESSAGE = "Command cancelled";

export interface RunShellCommandOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxBuffer?: number;
  abortSignal?: AbortSignal;
}

export interface RunShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted?: boolean;
}

function mergeEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

function truncateBuffer(text: string, maxBuffer: number): string {
  if (text.length <= maxBuffer) {
    return text;
  }

  return text.slice(0, maxBuffer);
}

// execFile collects stdout/stderr separately; spawn path matches that (no interleaving).
async function runWithExecFile(
  options: RunShellCommandOptions,
): Promise<RunShellCommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = mergeEnv(options.env);
  const maxBuffer = options.maxBuffer ?? 50 * 1024 * 2;
  const timeout = options.timeoutMs;

  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", options.command], {
      cwd,
      env,
      timeout,
      maxBuffer,
    });

    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      exitCode: 0,
    };
  } catch (error: unknown) {
    if (error && typeof error === "object") {
      const execError = error as {
        killed?: boolean;
        code?: number | string;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };

      const exitCode = execError.killed ? -1 : Number(execError.code ?? -1);
      const stdout = String(execError.stdout ?? "");
      const stderr = execError.killed
        ? TIMEOUT_MESSAGE
        : String(execError.stderr ?? "");

      return { stdout, stderr, exitCode };
    }

    throw new Error(`Unexpected error executing command: ${String(error)}`);
  }
}

async function runWithSpawn(
  options: RunShellCommandOptions,
): Promise<RunShellCommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = mergeEnv(options.env);
  const maxBuffer = options.maxBuffer ?? 50 * 1024 * 2;
  const timeoutMs = options.timeoutMs;
  const signal = options.abortSignal;

  return await new Promise<RunShellCommandResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", options.command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (result: RunShellCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const appendStdout = (chunk: Buffer): void => {
      stdout = truncateBuffer(stdout + chunk.toString("utf8"), maxBuffer);
    };

    const appendStderr = (chunk: Buffer): void => {
      stderr = truncateBuffer(stderr + chunk.toString("utf8"), maxBuffer);
    };

    child.stdout?.on("data", appendStdout);
    child.stderr?.on("data", appendStderr);

    let timeoutHandle: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
    }

    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (error) => {
      finish({
        stdout,
        stderr: stderr || String(error.message),
        exitCode: -1,
        aborted,
      });
    });

    child.on("close", (code) => {
      if (aborted || signal?.aborted) {
        finish({
          stdout,
          stderr: stderr || CANCEL_MESSAGE,
          exitCode: -1,
          aborted: true,
        });
        return;
      }

      if (timedOut) {
        finish({
          stdout,
          stderr: stderr || TIMEOUT_MESSAGE,
          exitCode: -1,
        });
        return;
      }

      finish({
        stdout,
        stderr,
        exitCode: code ?? -1,
      });
    });
  });
}

export async function runShellCommand(
  options: RunShellCommandOptions,
): Promise<RunShellCommandResult> {
  if (options.abortSignal) {
    return runWithSpawn(options);
  }

  return runWithExecFile(options);
}

export function createShellRunOptionsFromRuntimeConfig(config: {
  bashDefaultTimeoutMs: number;
  toolOutputInlineLimit: number;
}): Pick<RunShellCommandOptions, "timeoutMs" | "maxBuffer"> {
  return {
    timeoutMs: config.bashDefaultTimeoutMs,
    maxBuffer: config.toolOutputInlineLimit * 2,
  };
}
