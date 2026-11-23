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
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxBuffer?: number;
  agentMode?: AgentMode;
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
  const trace = startOperatorShellTrace(options.createTraceRun, trimmed, {
    cwd: options.cwd ?? process.cwd(),
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

  try {
    ui.setMode("running");
    ui.status(`Running: ${trimmed}`);
    ui.bashCommand(trimmed);

    const result = await runShellCommand({
      command: trimmed,
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      abortSignal: options.abortSignal,
    });

    trace.finish(operatorShellOutcome(result), result);
    ui.bashOutput(result.stdout, result.stderr, result.exitCode);
  } catch (error) {
    trace.finish(options.abortSignal?.aborted ? "cancelled" : "launch_failed");
    throw error;
  } finally {
    ui.clearEphemeralSurfaces();
    ui.setMode("awaitingInput");
  }
}
