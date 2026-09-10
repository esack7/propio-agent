import type { ToolExecutionResult } from "./types.js";
import type { PathToolOptions } from "./localOptions.js";
import type { ToolExecutionContext } from "./execution.js";
import type { ShellExecutor } from "./nodeShell.js";
import { normalizeToolPath } from "./shared.js";
import { PresentedTool } from "./interface.js";
import type { ToolDisplayAdapter } from "./displayAdapter.js";
import { ChatTool } from "@propio-ai/providers";
import {
  classifyGlobalInstallCommand,
  GLOBAL_INSTALL_DENIED_MESSAGE,
  type GlobalInstallApprovalRequest,
} from "./globalInstallGuard.js";
import { runShellCommand } from "./runShellCommand.js";

export type { GlobalInstallApprovalRequest } from "./globalInstallGuard.js";

export interface BashGlobalInstallGateConfig {
  requestGlobalInstallApproval?: (
    request: GlobalInstallApprovalRequest,
  ) => Promise<boolean>;
  allowGlobalInstallsWithoutPrompt: boolean;
}

export interface BashToolConfig extends PathToolOptions {
  readonly workspaceRoot?: string;
  readonly shellExecutor?: ShellExecutor;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly outputInlineLimit?: number;
  readonly globalInstallGate?: BashGlobalInstallGateConfig;
}

interface BashToolResult {
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}

function countNonEmptyLines(output: string): number {
  return output.split("\n").filter((line) => line.trim().length > 0).length;
}

function formatNonZeroExit(parsed: BashToolResult): string {
  const exit = parsed.exit_code ?? "?";
  const stderr = (parsed.stderr ?? "").replace(/\s+/g, " ").trim();

  if (stderr.length === 0) {
    return `Exit ${exit}`;
  }

  const preview = stderr.length > 60 ? `${stderr.slice(0, 60)}...` : stderr;
  return `Exit ${exit}: ${preview}`;
}

function formatZeroExit(parsed: BashToolResult): string {
  const lines = countNonEmptyLines(parsed.stdout ?? "");

  return lines > 0
    ? `Exit 0 (${lines} line${lines === 1 ? "" : "s"})`
    : "Exit 0";
}

function formatBashToolResult(parsed: BashToolResult): string {
  return parsed.exit_code !== 0
    ? formatNonZeroExit(parsed)
    : formatZeroExit(parsed);
}

export class BashTool implements PresentedTool {
  readonly name = "bash";
  readonly description = "Run a shell command.";
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly outputInlineLimit: number;
  private readonly globalInstallGate?: BashGlobalInstallGateConfig;

  constructor(private readonly config?: BashToolConfig) {
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? 120000;
    this.maxTimeoutMs = config?.maxTimeoutMs ?? 600000;
    this.outputInlineLimit = config?.outputInlineLimit ?? 50 * 1024;
    this.globalInstallGate = config?.globalInstallGate;
  }

  getDisplayAdapter(): ToolDisplayAdapter {
    return {
      renderUse(input) {
        const cmd = input.command;
        return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
      },
      renderResult(result) {
        try {
          return formatBashToolResult(JSON.parse(result) as BashToolResult);
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
    await this.assertGlobalInstallAllowed(command);

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
    return { status: result.aborted ? "error" : "success", content };
  }

  private resolveExecutionOptions(args: Record<string, unknown>) {
    const cwd = (this.config?.resolvePath ?? normalizeToolPath)(
      args.cwd ?? this.config?.workspaceRoot ?? process.cwd(),
    );
    const envOverrides =
      args.env !== undefined ? (args.env as Record<string, string>) : {};
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

  private async assertGlobalInstallAllowed(command: string): Promise<void> {
    const classification = classifyGlobalInstallCommand(command);
    if (!classification.matched) {
      return;
    }

    const gate = this.globalInstallGate;
    if (gate?.allowGlobalInstallsWithoutPrompt) {
      return;
    }

    const reason =
      classification.reason ??
      "This command would install software globally on the system.";

    if (gate?.requestGlobalInstallApproval) {
      const approved = await gate.requestGlobalInstallApproval({
        command,
        reason,
      });
      if (!approved) {
        throw new Error(`${GLOBAL_INSTALL_DENIED_MESSAGE} Command: ${command}`);
      }
      return;
    }

    throw new Error(`${GLOBAL_INSTALL_DENIED_MESSAGE} Command: ${command}`);
  }
}
