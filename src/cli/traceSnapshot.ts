import { z } from "zod";
import {
  inspectTraceReadResult,
  readTraceJournal,
  summarizeProviderMeasurements,
  type TraceEventEnvelope,
  type TraceInspection,
  type TraceReadWarning,
} from "../trace/index.js";

const envelopeSchema = z.object({
  version: z.literal(1),
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  observedAt: z.string(),
  monotonicNanoseconds: z.string(),
  component: z.string(),
  type: z.string(),
  identity: z
    .record(z.string(), z.string())
    .and(z.object({ sessionId: z.string(), runId: z.string() })),
  payload: z.unknown(),
});
const providerSchema = z.object({
  type: z.string(),
  provider: z.string(),
  requestedModel: z.string(),
  actualModel: z.string().optional(),
  endpointClass: z.string().optional(),
  trace: z.object({
    requestId: z.string(),
    purpose: z.enum(["answer", "summarize", "recovery"]),
  }),
  attemptId: z.string().optional(),
  attemptNumber: z.number().int().positive().optional(),
  availability: z.enum(["reported", "partial", "unavailable"]).optional(),
  reportKind: z.enum(["delta", "cumulative"]).optional(),
  usage: z.record(z.string(), z.number().finite().nonnegative()).optional(),
  providerReportedCost: z
    .object({
      amount: z.number().finite().nonnegative(),
      currency: z.string().optional(),
    })
    .optional(),
});

function validProviderMetadata(event: TraceEventEnvelope): boolean {
  if (event.component !== "provider") return true;
  const parsed = providerSchema.safeParse(event.payload);
  if (!parsed.success) return false;
  const payload = parsed.data;
  if (payload.type !== event.type) return false;
  if (
    event.identity.requestId !== undefined &&
    event.identity.requestId !== payload.trace.requestId
  )
    return false;
  if (
    event.identity.attemptId !== undefined &&
    event.identity.attemptId !== payload.attemptId
  )
    return false;
  return (
    event.type !== "provider_usage_reported" ||
    payload.availability !== undefined
  );
}

export interface TraceSnapshot {
  readonly events: readonly TraceEventEnvelope[];
  readonly inspection: TraceInspection;
  readonly warnings: readonly string[];
  readonly complete: boolean;
  readonly omittedRecordCount: number;
  readonly readWarnings: readonly TraceReadWarning[];
}

/** Read once: inspection and timeline describe the same append-only snapshot. */
export function readTraceSnapshot(
  journalPath: string | number,
  sessionId: string,
  runId: string,
): TraceSnapshot {
  const read = readTraceJournal(journalPath);
  const warnings = read.warnings.map((w) => `${w.type} at line ${w.line}`);
  const events: TraceEventEnvelope[] = [];
  let omittedRecordCount = 0;
  for (const candidate of read.events) {
    if (
      !envelopeSchema.safeParse(candidate).success ||
      !validProviderMetadata(candidate)
    ) {
      omittedRecordCount++;
      warnings.push(
        "Invalid event envelope or provider metadata; record omitted",
      );
      continue;
    }
    if (
      candidate.identity.sessionId !== sessionId ||
      candidate.identity.runId !== runId
    ) {
      omittedRecordCount++;
      warnings.push(
        "Event identity does not match the journal location; record omitted",
      );
      continue;
    }
    events.push(candidate);
  }
  events.sort((a, b) => a.sequence - b.sequence);
  if (events.some((event, index) => event.sequence !== index + 1))
    warnings.push("Event sequence has gaps or duplicates");
  if (events.length === 0) warnings.push("Journal has no valid events");
  const inspection = inspectTraceReadResult({
    events,
    warnings: read.warnings,
  });
  if (inspection.operations.length === 0 || !inspection.captureComplete)
    warnings.push("Capture is incomplete or still in progress");
  const complete = warnings.length === 0;
  return {
    events,
    omittedRecordCount,
    readWarnings: read.warnings,
    warnings,
    complete,
    inspection: complete
      ? inspection
      : {
          ...inspection,
          captureComplete: false,
          providerMeasurements: summarizeProviderMeasurements(events, {
            captureComplete: false,
          }),
        },
  };
}
