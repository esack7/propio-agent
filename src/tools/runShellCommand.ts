import { execFile, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MESSAGE = "Command timed out and was killed";
const CANCEL_MESSAGE = "Command cancelled";
export const MAXBUFFER_TRUNCATION_MESSAGE =
  "stdout or stderr maxBuffer length exceeded";

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
  maxBufferExceeded?: boolean;
}

function mergeEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

export function normalizeExecErrorCode(code: unknown): number {
  if (typeof code === "number" && Number.isFinite(code)) {
    return code;
  }

  if (typeof code === "string" && /^\d+$/.test(code)) {
    return Number.parseInt(code, 10);
  }

  return -1;
}

function formatExecErrorStderr(error: {
  killed?: boolean;
  code?: number | string;
  stderr?: string | Buffer;
  message?: string;
}): string {
  if (error.killed) {
    return TIMEOUT_MESSAGE;
  }

  const stderr = String(error.stderr ?? "");
  if (stderr.length > 0) {
    return stderr;
  }

  if (typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }

  if (typeof error.code === "string" && error.code.length > 0) {
    return error.code;
  }

  return "";
}

function appendMaxBufferNotice(stderr: string): string {
  if (stderr.includes(MAXBUFFER_TRUNCATION_MESSAGE)) {
    return stderr;
  }

  return stderr.length > 0
    ? `${stderr}\n${MAXBUFFER_TRUNCATION_MESSAGE}`
    : MAXBUFFER_TRUNCATION_MESSAGE;
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
        message?: string;
      };

      const exitCode = execError.killed
        ? -1
        : normalizeExecErrorCode(execError.code);
      const stdout = String(execError.stdout ?? "");
      let stderr = formatExecErrorStderr(execError);
      const maxBufferExceeded =
        execError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      if (maxBufferExceeded) {
        stderr = appendMaxBufferNotice(stderr);
      }

      return maxBufferExceeded
        ? { stdout, stderr, exitCode, maxBufferExceeded: true }
        : { stdout, stderr, exitCode };
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
    let maxBufferExceeded = false;

    const killForMaxBuffer = (): void => {
      if (maxBufferExceeded) {
        return;
      }

      maxBufferExceeded = true;
      child.kill();
    };

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
      if (maxBufferExceeded) {
        return;
      }

      const next = stdout + chunk.toString("utf8");
      if (next.length > maxBuffer) {
        stdout = next.slice(0, maxBuffer);
        killForMaxBuffer();
        return;
      }

      stdout = next;
    };

    const appendStderr = (chunk: Buffer): void => {
      if (maxBufferExceeded) {
        return;
      }

      const next = stderr + chunk.toString("utf8");
      if (next.length > maxBuffer) {
        stderr = next.slice(0, maxBuffer);
        killForMaxBuffer();
        return;
      }

      stderr = next;
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
        ...(maxBufferExceeded ? { maxBufferExceeded: true } : {}),
      });
    });

    child.on("close", (code) => {
      if (aborted || signal?.aborted) {
        finish({
          stdout,
          stderr: stderr || CANCEL_MESSAGE,
          exitCode: -1,
          aborted: true,
          ...(maxBufferExceeded ? { maxBufferExceeded: true } : {}),
        });
        return;
      }

      if (timedOut) {
        finish({
          stdout,
          stderr: stderr || TIMEOUT_MESSAGE,
          exitCode: -1,
          ...(maxBufferExceeded ? { maxBufferExceeded: true } : {}),
        });
        return;
      }

      if (maxBufferExceeded) {
        finish({
          stdout,
          stderr: appendMaxBufferNotice(stderr),
          exitCode: -1,
          maxBufferExceeded: true,
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
