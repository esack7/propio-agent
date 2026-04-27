import { execFile } from "child_process";
import { promisify } from "util";
import { ExecutableTool } from "./interface.js";
import { ChatTool } from "../providers/types.js";
import { truncateText } from "./shared.js";

const execFileAsync = promisify(execFile);

export class BashTool implements ExecutableTool {
  readonly name = "bash";
  readonly description = "Run a shell command.";
  private readonly DEFAULT_TIMEOUT = 30000;
  private readonly MAX_OUTPUT_SIZE = 50 * 1024;

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
              description: "Timeout in milliseconds. Default: 30000",
              default: 30000,
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
    const timeout =
      args.timeout !== undefined
        ? (args.timeout as number)
        : this.DEFAULT_TIMEOUT;
    const env = { ...process.env, ...envOverrides };

    try {
      const { stdout, stderr } = await execFileAsync(
        "/bin/sh",
        ["-c", command],
        {
          cwd,
          env,
          timeout,
          maxBuffer: this.MAX_OUTPUT_SIZE * 2,
        },
      );

      const truncatedStdout = truncateText(stdout, this.MAX_OUTPUT_SIZE);
      const truncatedStderr = truncateText(stderr, this.MAX_OUTPUT_SIZE);

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

        const truncatedStdout = truncateText(stdout, this.MAX_OUTPUT_SIZE);
        const truncatedStderr = truncateText(stderr, this.MAX_OUTPUT_SIZE);

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
