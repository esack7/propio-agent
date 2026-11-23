import type { TraceEventEnvelope, TraceInspection } from "../trace/index.js";
import {
  isTraceOperationStart,
  isTraceOperationTerminal,
  redactTraceValue,
} from "../trace/index.js";
import {
  keepStartWithinDisplayWidth,
  wrapVisibleText,
} from "../ui/displayWidth.js";
import { visibleText } from "../ui/visibleText.js";
import type { TraceSnapshot } from "./traceSnapshot.js";

const METADATA_KEYS = [
  "provider",
  "model",
  "requestedModel",
  "actualModel",
  "purpose",
  "endpointClass",
  "toolName",
  "decision",
  "actor",
  "rule",
  "reason",
  "status",
  "outcome",
  "errorName",
  "attemptNumber",
  "availability",
  "retryAfterMs",
  "delayMs",
] as const;

function metadata(
  event: TraceEventEnvelope,
): Record<string, string | number | boolean> {
  if (!event.payload || typeof event.payload !== "object") return {};
  const payload = event.payload as Record<string, unknown>;
  const result: Record<string, string | number | boolean> = {};
  for (const key of METADATA_KEYS) {
    const value = payload[key];
    if (typeof value === "string")
      result[key] = value.length > 240 ? `${value.slice(0, 240)}…` : value;
    else if (
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      result[key] = value;
  }
  return redactTraceValue({
    ...result,
    ...usageMetadata(payload.usage),
  }) as Record<string, string | number | boolean>;
}

function usageMetadata(usage: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (!usage || typeof usage !== "object") return result;
  for (const [key, value] of Object.entries(usage)) {
    if (
      [
        "inputTokens",
        "outputTokens",
        "cacheReadInputTokens",
        "cacheWriteInputTokens",
        "reasoningTokens",
        "totalTokens",
      ].includes(key) &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      result[key] = value;
  }
  return result;
}

function clock(event?: TraceEventEnvelope): bigint | undefined {
  const value = event?.monotonicNanoseconds;
  return value && /^\d{1,30}$/.test(value) ? BigInt(value) : undefined;
}
function elapsed(
  start: bigint | undefined,
  end: bigint | undefined,
): number | null {
  if (start === undefined || end === undefined || end < start) return null;
  const ms = Number(end - start) / 1e6;
  return Number.isSafeInteger(Math.trunc(ms)) ? ms : null;
}

function reportedDuration(event: TraceEventEnvelope): number | null {
  if (!event.payload || typeof event.payload !== "object") return null;
  const value = (event.payload as { durationMs?: unknown }).durationMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function traceTimeline(snapshot: TraceSnapshot) {
  const origin = clock(snapshot.events[0]);
  const starts = new Map<string, bigint | undefined>();
  return snapshot.events.map((event) => {
    const key = event.identity.attemptId
      ? `attempt:${event.identity.attemptId}`
      : event.identity.operationId
        ? `operation:${event.identity.operationId}`
        : undefined;
    if (key && isTraceOperationStart(event.type)) starts.set(key, clock(event));
    const terminal = isTraceOperationTerminal(event.type);
    return {
      sequence: event.sequence,
      relativeMs: elapsed(origin, clock(event)),
      durationMs: terminal
        ? ((key ? elapsed(starts.get(key), clock(event)) : null) ??
          reportedDuration(event))
        : null,
      component: event.component,
      type: event.type,
      identity: event.identity,
      metadata: metadata(event),
    };
  });
}

export interface TraceRunSummary {
  readonly sessionId: string;
  readonly runId: string;
  readonly observedAt: string | null;
  readonly complete: boolean;
  readonly eventCount: number;
  readonly warnings: readonly string[];
}

export function summarizeTraceRun(
  sessionId: string,
  runId: string,
  snapshot: TraceSnapshot,
): TraceRunSummary {
  const observedAt = snapshot.inspection.firstObservedAt;
  return {
    sessionId,
    runId,
    observedAt:
      observedAt && Number.isFinite(Date.parse(observedAt)) ? observedAt : null,
    complete: snapshot.complete,
    eventCount: snapshot.events.length,
    warnings: snapshot.warnings,
  };
}

export function renderTraceLines(
  lines: readonly string[],
  width?: number,
): string {
  if (width === undefined) return lines.map(visibleText).join("\n") + "\n";
  const columns = Number.isFinite(width)
    ? Math.max(20, Math.min(240, Math.floor(width)))
    : 100;
  return (
    lines
      .flatMap((line) => wrapVisibleText(visibleText(line), columns))
      .join("\n") + "\n"
  );
}

function measurementLines(inspection: TraceInspection): string[] {
  const { providerMeasurements: m } = inspection;
  const tokens = m.usage.usage;
  return [
    `Requests: ${m.requestCount}; attempts: ${m.attemptCount}; retry attempts: ${m.retries.attemptCount}`,
    `Tokens (${m.usage.completeness}): input=${tokens?.inputTokens ?? "unknown"} output=${tokens?.outputTokens ?? "unknown"} total=${tokens?.totalTokens ?? "unknown"}`,
  ];
}

export function traceShowLines(
  summary: TraceRunSummary,
  snapshot: TraceSnapshot,
  timeline: ReturnType<typeof traceTimeline>,
): string[] {
  return [
    `Run ${summary.runId} (session ${summary.sessionId})`,
    `Capture: ${summary.complete ? "complete" : "incomplete"}; events: ${summary.eventCount}; started: ${summary.observedAt ?? "unknown"}`,
    ...snapshot.warnings.map((w) => `Warning: ${w}`),
    ...measurementLines(snapshot.inspection),
    "Timeline (sequence order; ms relative to first event):",
    ...timeline.flatMap((event) => {
      const identity = Object.entries(event.identity)
        .filter(([key]) => key !== "runId" && key !== "sessionId")
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      const details = Object.entries(event.metadata)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      return [
        `#${event.sequence} +${event.relativeMs ?? "unknown"}ms ${event.component}/${event.type}${event.durationMs === null ? "" : ` duration=${event.durationMs}ms`}`,
        ...(identity ? [`  ${identity}`] : []),
        ...(details ? [`  ${details}`] : []),
      ];
    }),
  ];
}

export function traceListLines(
  runs: readonly TraceRunSummary[],
  warnings: readonly string[],
): string[] {
  return [
    ...(runs.length
      ? runs.map(
          (run) =>
            `${run.observedAt ?? "unknown time"} ${run.runId} session=${run.sessionId} ${run.complete ? "complete" : "incomplete"} events=${run.eventCount}`,
        )
      : ["No trace runs found."]),
    ...warnings.map((w) => `Warning: ${keepStartWithinDisplayWidth(w, 500)}`),
  ];
}
