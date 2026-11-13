import {
  killShellProcessGroups,
  terminateShellProcessGroups,
} from "../tools/processGroups.js";

/**
 * Exit once every shell command this process started is gone.
 *
 * Shell commands run in their own process groups, so the terminal's SIGINT no
 * longer reaches them, and an escalation timer dies with the process. Waiting
 * here is what makes Ctrl+C stop a command that ignores SIGTERM. A second
 * SIGINT while waiting kills what is left at once and exits.
 */
export async function exitAfterShellCleanup(
  exitCode: number,
  exit: (code: number) => never = process.exit,
): Promise<never> {
  const force = (): void => {
    killShellProcessGroups();
    exit(exitCode === 0 ? 130 : exitCode);
  };
  process.on("SIGINT", force);
  try {
    await terminateShellProcessGroups();
  } finally {
    process.off("SIGINT", force);
  }
  return exit(exitCode);
}
