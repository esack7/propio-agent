import {
  discoverTraceRuns,
  readDiscoveredTrace,
  selectTraceRun,
} from "./traceDiscovery.js";
import {
  summarizeProviderMeasurements,
  type TraceEventEnvelope,
} from "../trace/index.js";
import {
  traceShowLines,
  summarizeTraceRun,
  traceTimeline,
} from "./tracePresentation.js";
import { visibleText } from "../ui/visibleText.js";

export interface SessionTraceIdentity {
  sessionId: string;
  runId?: string;
}

export function inspectSessionUsage(root: string, sessionId: string) {
  const discovered = discoverTraceRuns(root, sessionId);
  const warnings = [...discovered.warnings];
  const runs = discovered.runs.map((run) => {
    const snapshot = readDiscoveredTrace(run);
    warnings.push(...snapshot.warnings);
    return { runId: run.runId, ...snapshot };
  });
  // Request IDs are scoped to a run. Namespace only the aggregation copy;
  // returned journals retain their original identities and timestamps.
  const events: TraceEventEnvelope[] = runs.flatMap((run) =>
    run.events.map((event) => {
      if (event.component !== "provider") return event;
      const payload = event.payload as Record<string, unknown>;
      const trace = payload.trace as Record<string, unknown> | undefined;
      if (!trace) return event;
      return {
        ...event,
        payload: {
          ...payload,
          trace: { ...trace, requestId: `${run.runId}:${trace.requestId}` },
        },
      };
    }),
  );
  return {
    sessionId,
    runs,
    warnings,
    measurements: summarizeProviderMeasurements(events, {
      captureComplete: warnings.length === 0,
    }),
  };
}

export function sessionInspectionLines(
  root: string,
  identity: SessionTraceIdentity,
  command: "/trace" | "/usage",
): string[] {
  if (command === "/trace") {
    if (!identity.runId) return ["No foreground trace available yet."];
    const run = selectTraceRun(root, identity.runId, identity.sessionId);
    const snapshot = readDiscoveredTrace(run);
    return traceShowLines(
      summarizeTraceRun(run.sessionId, run.runId, snapshot),
      snapshot,
      traceTimeline(snapshot),
    ).map(visibleText);
  }
  const result = inspectSessionUsage(root, identity.sessionId);
  const m = result.measurements;
  return [
    `Session ${identity.sessionId}: ${result.runs.length} runs; requests=${m.requestCount}; attempts=${m.attemptCount}; retries=${m.retries.attemptCount}`,
    ...Object.entries(m.usage.metricCompleteness).map(
      ([metric, completeness]) =>
        `${metric}: ${m.usage.usage?.[metric as keyof NonNullable<typeof m.usage.usage>] ?? "unknown"} (${completeness})`,
    ),
    ...m.attempts.map(
      (a) =>
        `${a.provider}/${a.actualModel ?? a.requestedModel} purpose=${a.purpose} request=${a.requestId} attempt=${a.attemptId ?? "unknown"}`,
    ),
    ...result.warnings,
  ].map(visibleText);
}

export function foregroundTraceHint(
  root: string,
  identity: SessionTraceIdentity,
) {
  try {
    if (!identity.runId) return { available: false as const };
    const snapshot = readDiscoveredTrace(
      selectTraceRun(root, identity.runId, identity.sessionId),
    );
    if (!snapshot.events.length) return { available: false as const };
    const quote = (value: string) => `'${value.split("'").join("'\\''")}'`;
    return {
      available: true as const,
      sessionId: identity.sessionId,
      runId: identity.runId,
      complete: snapshot.complete,
      command: `propio trace show ${quote(identity.runId)} --session ${quote(identity.sessionId)}`,
    };
  } catch {
    return { available: false as const };
  }
}
