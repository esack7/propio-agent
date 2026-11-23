import { randomUUID } from "node:crypto";
import type { TraceMaterialReference } from "../trace/types.js";
import type { AgentTraceRun } from "../agent.js";
import type { RunShellCommandResult } from "../tools/runShellCommand.js";

/** All capture stages are independent: a broken sink cannot control execution. */
function observe(action: () => void): void {
  try {
    action();
  } catch {
    // The journal reports its own capture failures where supported.
  }
}

function resultMetadata(result: RunShellCommandResult | undefined) {
  if (!result) return {};
  const { exitCode, terminationSignal, maxBufferExceeded, stdout, stderr } =
    result;
  return {
    exitCode,
    terminationSignal,
    maxBufferExceeded,
    stdoutLength: stdout.length,
    stderrLength: stderr.length,
  };
}

export function startOperatorShellTrace(
  createRun: (() => AgentTraceRun | undefined) | undefined,
  command: string,
  metadata: {
    cwd: string;
    mode: string;
    timeoutMs?: number;
    maxBuffer?: number;
  },
) {
  let run: AgentTraceRun | undefined;
  observe(() => {
    run = createRun?.();
  });
  const started = performance.now();
  const operationId = randomUUID();
  const record = (type: string, payload: Record<string, unknown>) => {
    observe(() =>
      run?.recorder.record(
        {
          component: "cli",
          type,
          identity: { operationId },
          payload: {
            actor: "user",
            source: "operator_shell",
            ...payload,
          },
        },
        { durable: true },
      ),
    );
  };
  const capture = (value: unknown) => {
    let material: TraceMaterialReference | undefined;
    observe(() => {
      if (run?.recorder.captureLevel === "full")
        material = run.recorder.captureMaterial?.(value);
    });
    return material;
  };
  record("operator_shell_started", {
    ...metadata,
    commandLength: command.length,
    material: capture({ command }),
  });
  let ended = false;
  return {
    policy(allowed: boolean) {
      record("tool_policy_decision", {
        decision: allowed ? "allow" : "deny",
        rule: `mode:${metadata.mode}`,
        toolName: "bash",
      });
    },
    finish(outcome: string, result?: RunShellCommandResult) {
      if (ended) return;
      ended = true;
      record(
        outcome === "cancelled"
          ? "operator_shell_cancelled"
          : outcome === "success"
            ? "operator_shell_completed"
            : "operator_shell_failed",
        {
          outcome,
          durationMs: result?.durationMs ?? performance.now() - started,
          ...resultMetadata(result),
          material: result
            ? capture({ stdout: result.stdout, stderr: result.stderr })
            : undefined,
        },
      );
      observe(() => run?.close?.());
    },
  };
}

export function operatorShellOutcome(result: RunShellCommandResult): string {
  if (result.aborted) return "cancelled";
  if (result.launchFailed) return "launch_failed";
  if (result.timedOut) return "timed_out";
  if (result.maxBufferExceeded) return "output_truncated";
  return result.exitCode === 0 ? "success" : "nonzero_exit";
}
