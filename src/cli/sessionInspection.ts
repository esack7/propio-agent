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
  const runs = discovered.runs.flatMap((run) => {
    try {
      const snapshot = readDiscoveredTrace(run);
      warnings.push(
        ...snapshot.warnings.map((warning) => `${run.runId}: ${warning}`),
      );
      return [{ runId: run.runId, ...snapshot }];
    } catch (error) {
      warnings.push(
        `${run.runId}: ${error instanceof Error ? error.message : "Unable to read journal"}`,
      );
      return [];
    }
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
    events,
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
    ...m.byPurpose.flatMap((purpose) => [
      `Purpose ${purpose.purpose}: requests=${purpose.requestCount}; attempts=${purpose.attemptCount}`,
      ...metricLines(purpose.usage),
    ]),
    ...modelUsageLines([
      { events: result.events, complete: result.warnings.length === 0 },
    ]),
    ...result.runs.flatMap((run) =>
      run.inspection.providerMeasurements.attempts.flatMap((a) => [
        `${a.provider}/${a.actualModel ?? a.requestedModel} purpose=${a.purpose} run=${run.runId} request=${a.requestId} attempt=${a.attemptId ?? "unknown"}`,
        ...metricLines(
          summarizeProviderMeasurements(
            run.events.filter((event) => {
              const payload = event.payload as {
                attemptId?: string;
                trace?: { requestId?: string };
              };
              return (
                event.component === "provider" &&
                payload.trace?.requestId === a.requestId &&
                payload.attemptId === a.attemptId
              );
            }),
            { captureComplete: run.complete },
          ).usage,
        ),
      ]),
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

function metricLines(
  aggregate: ReturnType<typeof summarizeProviderMeasurements>["usage"],
): string[] {
  return Object.entries(aggregate.metricCompleteness).map(
    ([metric, completeness]) =>
      `${metric}: ${aggregate.usage?.[metric as keyof NonNullable<typeof aggregate.usage>] ?? "unknown"} (${completeness})`,
  );
}

function modelUsageLines(
  runs: ReadonlyArray<{ events: TraceEventEnvelope[]; complete: boolean }>,
): string[] {
  const groups = new Map<string, TraceEventEnvelope[]>();
  for (const run of runs) {
    const attempts = summarizeProviderMeasurements(run.events).attempts;
    for (const event of run.events) {
      if (event.component !== "provider") continue;
      const payload = event.payload as {
        provider?: string;
        actualModel?: string;
        requestedModel?: string;
        attemptId?: string;
        trace?: { requestId?: string };
      };
      const attempt = attempts.find(
        (attempt) =>
          attempt.requestId === payload.trace?.requestId &&
          attempt.attemptId === payload.attemptId,
      );
      const key = attempt
        ? `${attempt.provider}/${attempt.actualModel ?? attempt.requestedModel}`
        : `${payload.provider}/${payload.actualModel ?? payload.requestedModel}`;
      const events = groups.get(key) ?? [];
      events.push(event);
      groups.set(key, events);
    }
  }
  return [...groups].flatMap(([model, events]) => [
    `Model ${model}`,
    ...metricLines(
      summarizeProviderMeasurements(events, {
        captureComplete: runs.every((run) => run.complete),
      }).usage,
    ),
  ]);
}
