import type { ToolMetadata } from "../policy/capabilities.js";
import type { ToolExecutionResult } from "./types.js";
import type { CommandOutcomeClassification } from "./types.js";
import type { PathToolOptions } from "./localOptions.js";
import type { ToolExecutionContext } from "./execution.js";
import type { ShellExecutor } from "./nodeShell.js";
import { normalizeToolPath } from "./shared.js";
import { PresentedTool } from "./interface.js";
import {
  displayTitle,
  outputTail,
  withFailure,
  type CommandDisplay,
  type ToolDisplay,
} from "./display.js";
import { ChatTool } from "@propio-ai/providers";
import { runShellCommand } from "./runShellCommand.js";

export interface BashToolConfig extends PathToolOptions {
  readonly workspaceRoot?: string;
  readonly shellExecutor?: ShellExecutor;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly outputInlineLimit?: number;
}

interface BashToolResult {
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}

function classifyCommandResult(
  result: Awaited<ReturnType<ShellExecutor>>,
): CommandOutcomeClassification {
  if (result.aborted) return "cancelled";
  if (result.maxBufferExceeded) return "output_limit";
  if (result.timedOut) return "timed_out";
  if (result.launchFailed) return "launch_failed";
  return result.exitCode === 0 ? "succeeded" : "nonzero_exit";
}

function parseBashToolResult(content: string): BashToolResult | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null &&
      typeof parsed === "object" &&
      ("exit_code" in parsed || "stdout" in parsed || "stderr" in parsed)
      ? (parsed as BashToolResult)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The command with what it wrote and how it ended. */
function commandResultBody(
  call: CommandDisplay,
  parsed: BashToolResult,
  classification: CommandOutcomeClassification | undefined,
): CommandDisplay {
  const stdout = outputTail(parsed.stdout ?? "");
  const stderr = outputTail(parsed.stderr ?? "");
  return {
    ...call,
    ...(typeof parsed.exit_code === "number"
      ? { exitCode: parsed.exit_code }
      : {}),
    ...(classification ? { classification } : {}),
    ...(stdout.tail ? { stdoutTail: stdout.tail } : {}),
    ...(stderr.tail ? { stderrTail: stderr.tail } : {}),
    stdoutLines: stdout.lines,
    stderrLines: stderr.lines,
    truncated: stdout.truncated || stderr.truncated,
  };
}

function commandFailure(
  classification: CommandOutcomeClassification | undefined,
): string {
  if (classification === "cancelled") return "Cancelled before it finished";
  if (classification === "timed_out") return "Timed out";
  return "Command failed";
}

export class BashTool implements PresentedTool {
  readonly name = "bash";
  readonly metadata: ToolMetadata = {
    capabilities: ["process"],
    readOnly: false,
    concurrencySafe: false,
  };
  readonly description = "Run a shell command.";
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly outputInlineLimit: number;

  constructor(private readonly config?: BashToolConfig) {
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? 120000;
    this.maxTimeoutMs = config?.maxTimeoutMs ?? 600000;
    this.outputInlineLimit = config?.outputInlineLimit ?? 50 * 1024;
  }

  describeCall(
    args: Readonly<Record<string, unknown>>,
  ): ToolDisplay<CommandDisplay> {
    const command = typeof args.command === "string" ? args.command : "";
    return {
      title: displayTitle(
        command ? `Running ${command}` : "Running shell command",
      ),
      body: {
        kind: "command",
        command,
        ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
        truncated: false,
      },
    };
  }

  describeResult(
    args: Readonly<Record<string, unknown>>,
    result: Readonly<ToolExecutionResult>,
  ): ToolDisplay {
    const call = this.describeCall(args);
    const parsed = parseBashToolResult(result.content);
    // A result that is not this tool's own output is a refusal or a failure
    // from before the command ran.
    if (!parsed) {
      return result.status === "success"
        ? call
        : withFailure(call, result.content);
    }
    const classification =
      result.outcome?.kind === "command"
        ? result.outcome.classification
        : undefined;
    const display: ToolDisplay<CommandDisplay> = {
      ...call,
      body: commandResultBody(call.body, parsed, classification),
    };
    return result.status === "success"
      ? display
      : withFailure(display, commandFailure(classification));
  }

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "bash",
        description:
          "Executes a shell command and returns structured stdout, stderr, and exit code output.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The shell command to execute",
            },
            cwd: {
              type: "string",
              description:
                "Working directory for command execution. Defaults to process.cwd(). For throwaway scripts or temp files you create, use the path from # Scratchpad Directory when that section is present. Prefer python -c or node -e when a script file is unnecessary.",
            },
            env: {
              type: "object",
              description:
                "Additional environment variables (merged with process.env)",
              additionalProperties: { type: "string" },
            },
            timeout: {
              type: "number",
              description: `Timeout in milliseconds. Default: ${this.defaultTimeoutMs}`,
              default: this.defaultTimeoutMs,
            },
          },
          required: ["command"],
        },
      },
    };
  }

  async executeWithStatus(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolExecutionResult> {
    context.signal?.throwIfAborted();
    const command = args.command as string;
    const executionOptions = this.resolveExecutionOptions(args);

    context.signal?.throwIfAborted();
    const result = await (this.config?.shellExecutor ?? runShellCommand)({
      command,
      ...executionOptions,
      abortSignal: context.signal,
      maxBuffer: this.outputInlineLimit * 2,
    });

    const content = JSON.stringify(
      {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
      },
      null,
      2,
    );
    return {
      status: result.aborted ? "error" : "success",
      content,
      outcome: {
        kind: "command",
        classification: classifyCommandResult(result),
        exitCode: result.exitCode,
        terminationSignal: result.terminationSignal,
        cwd: executionOptions.cwd,
        timeoutMs: executionOptions.timeoutMs,
        durationMs: result.durationMs,
        environmentKeys: Object.keys(executionOptions.env ?? {}).sort(),
        outputDiscarded: result.maxBufferExceeded === true,
        sideEffect: "unknown",
      },
    };
  }

  // fallow-ignore-next-line complexity
  private resolveExecutionOptions(args: Record<string, unknown>) {
    const cwd = (this.config?.resolvePath ?? normalizeToolPath)(
      args.cwd ?? this.config?.workspaceRoot ?? process.cwd(),
    );
    const envOverrides =
      args.env !== null && typeof args.env === "object"
        ? (args.env as Record<string, string>)
        : {};
    let timeout =
      args.timeout !== undefined
        ? (args.timeout as number)
        : this.defaultTimeoutMs;
    if (timeout > this.maxTimeoutMs) {
      timeout = this.maxTimeoutMs;
    }

    return { cwd, env: envOverrides, timeoutMs: timeout };
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    return (await this.executeWithStatus(args, context)).content;
  }
}
