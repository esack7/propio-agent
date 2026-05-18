import { execFile } from "child_process";
import { promisify } from "util";
import { ExecutableTool } from "./interface.js";
import type { ToolDisplayAdapter } from "./displayAdapter.js";
import { ChatTool } from "../providers/types.js";

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

  getDisplayAdapter(): ToolDisplayAdapter {
    return {
      renderUse(input) {
        const cmd = input.command;
        return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
      },
      renderResult(result) {
        try {
          const parsed = JSON.parse(result) as {
            exit_code?: number;
            stdout?: string;
            stderr?: string;
          };
          const exit = parsed.exit_code ?? "?";
          if (exit !== 0) {
            const stderr = (parsed.stderr ?? "").replace(/\s+/g, " ").trim();
            if (stderr.length > 0) {
              const preview =
                stderr.length > 60 ? `${stderr.slice(0, 60)}...` : stderr;
              return `Exit ${exit}: ${preview}`;
            }
            return `Exit ${exit}`;
          }
          const lines = (parsed.stdout ?? "")
            .split("\n")
            .filter((l) => l.trim().length > 0).length;
          return lines > 0 ? `Exit 0 (${lines} line${lines === 1 ? "" : "s"})` : "Exit 0";
        } catch {
          return null;
        }
      },
    };
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

      return JSON.stringify(
        {
          stdout,
          stderr,
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

        return JSON.stringify(
          {
            stdout,
            stderr,
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
