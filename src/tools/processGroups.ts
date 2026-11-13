import type { ChildProcess } from "child_process";

/** How long a command's process group gets to exit after SIGTERM. */
const DEFAULT_KILL_GRACE_MS = 2000;
/** How often a terminating group is checked for remaining members. */
const POLL_INTERVAL_MS = 25;
/** How long to keep checking after SIGKILL before giving up on a group. */
const AFTER_KILL_WAIT_MS = 1000;

/**
 * A shell command started as the leader of its own process group.
 *
 * Termination is tracked by asking the operating system whether the group
 * still has members, not by the shell's output closing: a descendant that
 * redirected its output keeps running after the shell has exited.
 */
export interface ShellProcessGroup {
  /** SIGTERM the group, then SIGKILL it after the grace period. Idempotent. */
  terminate(): void;
  /** Resolves once the group has no members, or after SIGKILL stopped helping. */
  readonly gone: Promise<void>;
  readonly terminating: boolean;
  /** Stop tracking a group whose command finished without being terminated. */
  release(): void;
}

/**
 * Groups this process started that are running or being terminated.
 *
 * This is process-level state on purpose: a process group belongs to the
 * operating-system process that created it, and the only cleanup that cannot
 * be skipped is the one at that process's exit. Phase 11 (`tools-hardening`)
 * moves local shell execution behind its own primitive; this registry goes
 * with it.
 */
const liveGroups = new Set<TrackedGroup>();
let exitHookInstalled = false;

interface TrackedGroup extends ShellProcessGroup {
  kill(): void;
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means members exist that we may not signal; treat as present.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(
  child: ChildProcess,
  pgid: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is gone, or could not be signalled as a group.
    try {
      child.kill(signal);
    } catch {
      // Nothing left to signal.
    }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Last resort when the process exits without draining (an uncaught error,
  // a direct process.exit). Exit handlers run synchronously, so the only
  // signal worth sending is one that cannot be ignored.
  process.on("exit", killShellProcessGroups);
}

/** Track a spawned shell that was started with `detached: true`. */
export function trackShellProcessGroup(
  child: ChildProcess,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
): ShellProcessGroup {
  const pgid = child.pid;
  let terminating = false;
  let settled = false;
  let resolveGone!: () => void;
  const gone = new Promise<void>((resolve) => {
    resolveGone = resolve;
  });
  let poll: NodeJS.Timeout | undefined;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(poll);
    liveGroups.delete(group);
    resolveGone();
  };

  const group: TrackedGroup = {
    get terminating() {
      return terminating;
    },
    gone,
    terminate(): void {
      if (terminating || settled) return;
      terminating = true;
      if (pgid === undefined) {
        child.kill("SIGTERM");
        settle();
        return;
      }
      signalGroup(child, pgid, "SIGTERM");
      const killAt = Date.now() + killGraceMs;
      let giveUpAt: number | undefined;
      const check = (): void => {
        if (!groupExists(pgid)) return settle();
        const now = Date.now();
        if (giveUpAt === undefined && now >= killAt) {
          signalGroup(child, pgid, "SIGKILL");
          giveUpAt = now + AFTER_KILL_WAIT_MS;
        } else if (giveUpAt !== undefined && now >= giveUpAt) {
          return settle();
        }
        poll = setTimeout(check, POLL_INTERVAL_MS);
      };
      poll = setTimeout(check, POLL_INTERVAL_MS);
    },
    release(): void {
      if (!terminating) settle();
    },
    kill(): void {
      if (pgid !== undefined) signalGroup(child, pgid, "SIGKILL");
      settle();
    },
  };

  // Without a pid the spawn failed and there is no group to track.
  if (pgid !== undefined) {
    liveGroups.add(group);
    installExitHook();
  }
  return group;
}

/**
 * Terminate every group still running or being terminated, and resolve once
 * all are gone. The CLI awaits this before it exits, so the escalation to
 * SIGKILL is not lost with the process.
 */
export async function terminateShellProcessGroups(): Promise<void> {
  const groups = [...liveGroups];
  for (const group of groups) group.terminate();
  await Promise.all(groups.map((group) => group.gone));
}

/** SIGKILL every tracked group now. Safe to call from an exit handler. */
export function killShellProcessGroups(): void {
  for (const group of [...liveGroups]) group.kill();
}
