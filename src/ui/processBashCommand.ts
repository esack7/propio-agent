import { runShellCommand } from "../tools/runShellCommand.js";
import type { TerminalUi } from "./terminal.js";

export interface ProcessBashCommandOptions {
  cwd?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxBuffer?: number;
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

  ui.setMode("running");
  ui.status(`Running: ${trimmed}`);

  try {
    ui.bashCommand(trimmed);

    const result = await runShellCommand({
      command: trimmed,
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      abortSignal: options.abortSignal,
    });

    ui.bashOutput(result.stdout, result.stderr, result.exitCode);
  } finally {
    ui.clearEphemeralSurfaces();
    ui.setMode("awaitingInput");
  }
}
