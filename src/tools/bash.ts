import { execFile } from "child_process";
import { promisify } from "util";
import { ExecutableTool } from "./interface.js";
import { ChatTool } from "../providers/types.js";
import { truncateText } from "./shared.js";

const execFileAsync = promisify(execFile);

export interface BashToolConfig {
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly outputInlineLimit?: number;
}

export class BashTool implements ExecutableTool {
  readonly name = "bash";
  readonly description = "Run a shell command.";
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly outputInlineLimit: number;

  constructor(config?: BashToolConfig) {
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? 120000;
    this.maxTimeoutMs = config?.maxTimeoutMs ?? 600000;
    this.outputInlineLimit = config?.outputInlineLimit ?? 50 * 1024;
  }

  getInvocationLabel(args: Record<string, unknown>): string | undefined {
    const command = args.command;
    return typeof command === "string" && command.length > 0
      ? `Running ${command}`
      : "Running shell command";
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
                "Working directory for command execution. Defaults to process.cwd()",
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

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = args.command as string;
    const cwd = args.cwd !== undefined ? (args.cwd as string) : process.cwd();
    const envOverrides =
      args.env !== undefined ? (args.env as Record<string, string>) : {};
    let timeout =
      args.timeout !== undefined
        ? (args.timeout as number)
        : this.defaultTimeoutMs;
    if (timeout > this.maxTimeoutMs) {
      timeout = this.maxTimeoutMs;
    }
    const env = { ...process.env, ...envOverrides };

    try {
      const { stdout, stderr } = await execFileAsync(
        "/bin/sh",
        ["-c", command],
        {
          cwd,
          env,
          timeout,
          maxBuffer: this.outputInlineLimit * 2,
        },
      );

      const truncatedStdout = truncateText(stdout, this.outputInlineLimit);
      const truncatedStderr = truncateText(stderr, this.outputInlineLimit);

      return JSON.stringify(
        {
          stdout: truncatedStdout.value,
          stderr: truncatedStderr.value,
          exit_code: 0,
        },
        null,
        2,
      );
    } catch (error: unknown) {
      if (error && typeof error === "object") {
        const execError = error as {
          killed?: boolean;
          code?: number;
          stdout?: string;
          stderr?: string;
        };

        const exitCode = execError.killed ? -1 : (execError.code ?? -1);
        const stdout = execError.stdout ?? "";
        const stderr = execError.killed
          ? "Command timed out and was killed"
          : (execError.stderr ?? "");

        const truncatedStdout = truncateText(stdout, this.outputInlineLimit);
        const truncatedStderr = truncateText(stderr, this.outputInlineLimit);

        return JSON.stringify(
          {
            stdout: truncatedStdout.value,
            stderr: truncatedStderr.value,
            exit_code: exitCode,
          },
          null,
          2,
        );
      }

      throw new Error(`Unexpected error executing command: ${String(error)}`);
    }
  }
}
