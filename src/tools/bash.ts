import { execFile } from "child_process";
import { promisify } from "util";
import { ExecutableTool } from "./interface";
import { ChatTool } from "../providers/types";

const execFileAsync = promisify(execFile);

/**
 * RunBashTool executes shell commands and returns structured output.
 * Disabled by default - must be explicitly enabled.
 */
export class RunBashTool implements ExecutableTool {
  readonly name = "run_bash";
  private readonly DEFAULT_TIMEOUT = 30000; // 30 seconds
  private readonly MAX_OUTPUT_SIZE = 50 * 1024; // 50KB

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "run_bash",
        description: "Executes a shell command and returns its output. WARNING: This tool can execute arbitrary commands. Disabled by default and must be explicitly enabled.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The shell command to execute",
            },
            cwd: {
              type: "string",
              description: "Working directory for command execution. Defaults to process.cwd()",
            },
            env: {
              type: "object",
              description: "Additional environment variables (merged with process.env)",
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
    const envOverrides = args.env !== undefined ? (args.env as Record<string, string>) : {};
    const timeout = args.timeout !== undefined ? (args.timeout as number) : this.DEFAULT_TIMEOUT;

    // Merge environment variables
    const env = { ...process.env, ...envOverrides };

    try {
      const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], {
        cwd,
        env,
        timeout,
        maxBuffer: this.MAX_OUTPUT_SIZE * 2, // Allow some headroom before internal truncation
      });

      // Truncate outputs if needed
      const truncatedStdout = this.truncateOutput(stdout);
      const truncatedStderr = this.truncateOutput(stderr);

      return JSON.stringify({
        stdout: truncatedStdout.value,
        stderr: truncatedStderr.value + (truncatedStderr.truncated ? "\n[stderr truncated]" : ""),
        exit_code: 0,
      }, null, 2);
    } catch (error: unknown) {
      // Handle timeout and non-zero exit codes
      if (error && typeof error === "object") {
        const execError = error as {
          killed?: boolean;
          code?: number;
          stdout?: string;
          stderr?: string;
        };

        let exitCode = -1;
        let stderr = "";
        let stdout = "";

        if (execError.killed) {
          // Timeout case
          stderr = "Command timed out and was killed";
          exitCode = -1;
        } else if (execError.code !== undefined) {
          // Non-zero exit code
          exitCode = execError.code;
        }

        // Capture any output that was produced before error
        stdout = execError.stdout !== undefined ? execError.stdout : "";
        stderr = stderr || (execError.stderr !== undefined ? execError.stderr : "");

        // Truncate outputs
        const truncatedStdout = this.truncateOutput(stdout);
        const truncatedStderr = this.truncateOutput(stderr);

        return JSON.stringify({
          stdout: truncatedStdout.value + (truncatedStdout.truncated ? "\n[stdout truncated]" : ""),
          stderr: truncatedStderr.value + (truncatedStderr.truncated ? "\n[stderr truncated]" : ""),
          exit_code: exitCode,
        }, null, 2);
      }

      // Unexpected error type
      throw new Error(`Unexpected error executing command: ${String(error)}`);
    }
  }

  private truncateOutput(output: string): { value: string; truncated: boolean } {
    if (output.length <= this.MAX_OUTPUT_SIZE) {
      return { value: output, truncated: false };
    }

    return {
      value: output.substring(0, this.MAX_OUTPUT_SIZE),
      truncated: true,
    };
  }
}
