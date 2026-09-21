import { StringDecoder } from "node:string_decoder";
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
  timedOut?: boolean;
  launchFailed?: boolean;
  terminationSignal?: string;
  durationMs: number;
}

interface ExecShellError {
  killed?: boolean;
  code?: number | string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
}

interface SpawnCloseState {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
  signalAborted: boolean;
  timedOut: boolean;
  maxBufferExceeded: boolean;
  terminationSignal: string | null;
  durationMs: number;
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

function isExecShellError(error: unknown): error is ExecShellError {
  return error !== null && typeof error === "object";
}

function appendMaxBufferNotice(stderr: string): string {
  if (stderr.includes(MAXBUFFER_TRUNCATION_MESSAGE)) {
    return stderr;
  }

  return stderr.length > 0
    ? `${stderr}\n${MAXBUFFER_TRUNCATION_MESSAGE}`
    : MAXBUFFER_TRUNCATION_MESSAGE;
}

function resultWithMaxBufferFlag(
  result: Omit<RunShellCommandResult, "maxBufferExceeded">,
  maxBufferExceeded: boolean,
): RunShellCommandResult {
  return maxBufferExceeded ? { ...result, maxBufferExceeded: true } : result;
}

function execErrorToResult(
  execError: ExecShellError,
  durationMs: number,
): RunShellCommandResult {
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

  return resultWithMaxBufferFlag(
    {
      stdout,
      stderr,
      exitCode,
      durationMs,
      ...(execError.killed === true ? { timedOut: true } : {}),
    },
    maxBufferExceeded,
  );
}

function spawnCloseStateToResult(
  state: SpawnCloseState,
): RunShellCommandResult {
  const base = {
    stdout: state.stdout,
    stderr: state.stderr,
    durationMs: state.durationMs,
    ...(state.terminationSignal
      ? { terminationSignal: state.terminationSignal }
      : {}),
  };

  if (state.aborted || state.signalAborted) {
    return resultWithMaxBufferFlag(
      {
        ...base,
        stderr: state.stderr || CANCEL_MESSAGE,
        exitCode: -1,
        aborted: true,
      },
      state.maxBufferExceeded,
    );
  }

  if (state.timedOut) {
    return resultWithMaxBufferFlag(
      {
        ...base,
        stderr: state.stderr || TIMEOUT_MESSAGE,
        exitCode: -1,
        timedOut: true,
      },
      state.maxBufferExceeded,
    );
  }

  if (state.maxBufferExceeded) {
    return {
      ...base,
      stderr: appendMaxBufferNotice(state.stderr),
      exitCode: -1,
      maxBufferExceeded: true,
    };
  }

  return {
    ...base,
    exitCode: state.code ?? -1,
  };
}

function resolveShellRuntimeOptions(options: RunShellCommandOptions) {
  return {
    startedAt: performance.now(),
    cwd: options.cwd ?? process.cwd(),
    env: mergeEnv(options.env),
    maxBuffer: options.maxBuffer ?? 50 * 1024 * 2,
    timeoutMs: options.timeoutMs,
  };
}

// execFile collects stdout/stderr separately; spawn path matches that (no interleaving).
async function runWithExecFile(
  options: RunShellCommandOptions,
): Promise<RunShellCommandResult> {
  const { startedAt, cwd, env, maxBuffer, timeoutMs } =
    resolveShellRuntimeOptions(options);

  try {
    const { stdout, stderr } = await execFileAsync(
      "/bin/sh",
      ["-c", options.command],
      {
        cwd,
        env,
        timeout: timeoutMs,
        maxBuffer,
      },
    );

    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      exitCode: 0,
      durationMs: performance.now() - startedAt,
    };
  } catch (error: unknown) {
    if (isExecShellError(error)) {
      return execErrorToResult(error, performance.now() - startedAt);
    }

    throw new Error(`Unexpected error executing command: ${String(error)}`);
  }
}

function createOutputCollector(maxBytes: number, exceeded: () => void) {
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  let text = "";
  let truncated = false;
  return {
    append(chunk: Buffer) {
      if (truncated) return;
      const remaining = Math.max(0, maxBytes - bytes);
      text += decoder.write(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > maxBytes) {
        truncated = true;
        exceeded();
      }
    },
    finish() {
      // A cap can cut a UTF-8 sequence. Discard that incomplete suffix rather
      // than manufacturing replacement characters for bytes we did not retain.
      if (!truncated) text += decoder.end();
      return text;
    },
  };
}

async function runWithSpawn(
  options: RunShellCommandOptions,
): Promise<RunShellCommandResult> {
  const { startedAt, cwd, env, maxBuffer, timeoutMs } =
    resolveShellRuntimeOptions(options);
  const signal = options.abortSignal;

  return await new Promise<RunShellCommandResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", options.command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

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

    const stdoutOutput = createOutputCollector(maxBuffer, killForMaxBuffer);
    const stderrOutput = createOutputCollector(maxBuffer, killForMaxBuffer);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!maxBufferExceeded) stdoutOutput.append(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!maxBufferExceeded) stderrOutput.append(chunk);
    });

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
      finish(
        resultWithMaxBufferFlag(
          {
            stdout: stdoutOutput.finish(),
            stderr: stderrOutput.finish() || String(error.message),
            exitCode: -1,
            aborted,
            launchFailed: true,
            durationMs: performance.now() - startedAt,
          },
          maxBufferExceeded,
        ),
      );
    });

    child.on("close", (code, terminationSignal) => {
      const stdout = stdoutOutput.finish();
      const stderr = stderrOutput.finish();
      finish(
        spawnCloseStateToResult({
          stdout,
          stderr:
            stderr ||
            (code && !aborted && !timedOut && !maxBufferExceeded
              ? `Command failed: /bin/sh -c ${options.command}\n`
              : ""),
          code,
          aborted,
          signalAborted: signal?.aborted ?? false,
          timedOut,
          maxBufferExceeded,
          terminationSignal,
          durationMs: performance.now() - startedAt,
        }),
      );
    });
  });
}

export async function runShellCommand(
  options: RunShellCommandOptions,
): Promise<RunShellCommandResult> {
  if (options.abortSignal?.aborted) {
    return {
      stdout: "",
      stderr: CANCEL_MESSAGE,
      exitCode: -1,
      aborted: true,
      durationMs: 0,
    };
  }
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
