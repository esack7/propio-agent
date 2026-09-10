import { isAbsolute } from "node:path";
import {
  runShellCommand,
  type RunShellCommandOptions,
  type RunShellCommandResult,
} from "./runShellCommand.js";

export type ShellExecutionOptions = Omit<RunShellCommandOptions, "cwd"> & {
  cwd: string;
};
export type ShellExecutionResult = RunShellCommandResult;
export type ShellExecutor = (
  options: ShellExecutionOptions,
) => Promise<ShellExecutionResult>;

/** Explicit Node /bin/sh adapter. Inherits process.env; does not isolate processes. */
export const executeNodeShell: ShellExecutor = async (options) => {
  if (!isAbsolute(options.cwd)) throw new Error("Shell cwd must be absolute");
  return runShellCommand(options);
};
