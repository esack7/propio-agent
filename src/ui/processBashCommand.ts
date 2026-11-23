import * as path from "node:path";
import type { AgentTraceRun } from "../agent.js";
import {
  startOperatorShellTrace,
  operatorShellOutcome,
} from "./operatorShellTrace.js";
import type { AgentMode } from "../modes/types.js";
import { checkBashAllowedForMode } from "../modes/bashPolicy.js";
import { runShellCommand } from "../tools/runShellCommand.js";
import type { TerminalUi } from "./terminal.js";

export interface ProcessBashCommandOptions {
  createTraceRun?: () => AgentTraceRun | undefined;
  cwd?: string;
  workspaceRoot?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxBuffer?: number;
  agentMode?: AgentMode;
}

function traceWorkingDirectory(cwd: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, cwd);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return "[outside workspace]";
  }
  return relative || ".";
}

export async function processBashCommand(
  command: string,
  ui: TerminalUi,
  options: ProcessBashCommandOptions = {},
): Promise<void> {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return;
  }

  const mode = options.agentMode ?? "execute";
  const cwd = options.cwd ?? process.cwd();
  const trace = startOperatorShellTrace(options.createTraceRun, trimmed, {
    cwd: traceWorkingDirectory(cwd, options.workspaceRoot ?? process.cwd()),
    mode,
    timeoutMs: options.timeoutMs,
    maxBuffer: options.maxBuffer,
  });
  const bashPolicy = checkBashAllowedForMode(trimmed, mode);
  trace.policy(bashPolicy.allowed);
  if (!bashPolicy.allowed) {
    trace.finish("policy_denied");
    ui.error(bashPolicy.reason ?? "Command not allowed in this mode");
    return;
  }

  let launchAttempted = false;
  try {
    ui.setMode("running");
    ui.status(`Running: ${trimmed}`);
    ui.bashCommand(trimmed);

    launchAttempted = true;
    const result = await runShellCommand({
      command: trimmed,
      cwd,
      timeoutMs: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      abortSignal: options.abortSignal,
    });

    trace.finish(operatorShellOutcome(result), result);
    ui.bashOutput(result.stdout, result.stderr, result.exitCode);
  } catch (error) {
    trace.finish(
      options.abortSignal?.aborted
        ? "cancelled"
        : launchAttempted
          ? "launch_failed"
          : "failed",
    );
    throw error;
  } finally {
    ui.clearEphemeralSurfaces();
    ui.setMode("awaitingInput");
  }
}
