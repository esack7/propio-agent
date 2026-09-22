import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readTraceJournal } from "./journal.js";
import {
  summarizeProviderMeasurements,
  type ProviderMeasurementSummary,
  type ProviderPricingResolver,
} from "./measurements.js";
import type { TraceEventEnvelope, TraceReadWarning } from "./types.js";

export interface TraceOperationSummary {
  readonly operationId: string;
  readonly component: string;
  readonly startedType: string;
  readonly terminalType?: string;
  readonly outcome: "completed" | "failed" | "cancelled" | "unknown";
}

export interface TraceInspection {
  readonly eventCount: number;
  readonly firstObservedAt?: string;
  readonly lastObservedAt?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly previousRunId?: string;
  readonly captureComplete: boolean;
  readonly warnings: ReadonlyArray<TraceReadWarning>;
  readonly operations: ReadonlyArray<TraceOperationSummary>;
  readonly providerMeasurements: ProviderMeasurementSummary;
}

export interface TraceInspectionOptions {
  readonly pricingResolver?: ProviderPricingResolver;
}

function terminalOutcome(type: string): TraceOperationSummary["outcome"] {
  if (type.includes("failed")) return "failed";
  if (type.includes("cancelled") || type.includes("interrupted"))
    return "cancelled";
  return "completed";
}

function isOperationStart(type: string): boolean {
  return type.endsWith("_started") || type.endsWith("_dispatched");
}

function isOperationTerminal(type: string): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].some((suffix) =>
    type.endsWith(`_${suffix}`),
  );
}

function applyOperationEvent(
  operations: Map<string, TraceOperationSummary>,
  event: TraceEventEnvelope,
): void {
  if (event.identity.attemptId) return;
  const operationId = event.identity.operationId;
  if (!operationId) return;
  if (isOperationStart(event.type)) {
    operations.set(operationId, {
      operationId,
      component: event.component,
      startedType: event.type,
      outcome: "unknown",
    });
    return;
  }
  const existing = operations.get(operationId);
  if (!existing || !isOperationTerminal(event.type)) return;
  operations.set(operationId, {
    ...existing,
    terminalType: event.type,
    outcome: terminalOutcome(event.type),
  });
}

function summarizeOperations(
  events: ReadonlyArray<TraceEventEnvelope>,
): TraceOperationSummary[] {
  const operations = new Map<string, TraceOperationSummary>();
  for (const event of events) {
    applyOperationEvent(operations, event);
  }
  return [...operations.values()];
}

export function inspectTraceJournal(
  journalPath: string,
  options: TraceInspectionOptions = {},
): TraceInspection {
  const { events, warnings } = readTraceJournal(journalPath);
  const first = events[0];
  const last = events[events.length - 1];
  const operations = summarizeOperations(events);
  return {
    eventCount: events.length,
    firstObservedAt: first?.observedAt,
    lastObservedAt: last?.observedAt,
    sessionId: first?.identity.sessionId,
    runId: first?.identity.runId,
    previousRunId: first?.identity.previousRunId,
    captureComplete:
      warnings.length === 0 &&
      operations.every((operation) => operation.outcome !== "unknown"),
    warnings,
    operations,
    providerMeasurements: summarizeProviderMeasurements(
      events,
      options.pricingResolver,
    ),
  };
}

export interface TraceExportManifest {
  readonly version: 1;
  readonly exportedAt: string;
  readonly captureLevel: "standard";
  readonly sessionId?: string;
  readonly runId?: string;
  readonly previousRunId?: string;
  readonly captureComplete: boolean;
  readonly warnings: ReadonlyArray<TraceReadWarning>;
  readonly providerMeasurements: ProviderMeasurementSummary;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }>;
}

export function exportTraceJournal(
  journalPath: string,
  destinationDirectory: string,
  options: TraceInspectionOptions = {},
): TraceExportManifest {
  const inspection = inspectTraceJournal(journalPath, options);
  const events = fs.readFileSync(journalPath);
  fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  const relativeEventsPath = "events.jsonl";
  fs.writeFileSync(
    path.join(destinationDirectory, relativeEventsPath),
    events,
    {
      mode: 0o600,
    },
  );
  const manifest: TraceExportManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    captureLevel: "standard",
    sessionId: inspection.sessionId,
    runId: inspection.runId,
    previousRunId: inspection.previousRunId,
    captureComplete: inspection.captureComplete,
    warnings: inspection.warnings,
    providerMeasurements: inspection.providerMeasurements,
    files: [
      {
        path: relativeEventsPath,
        sha256: createHash("sha256").update(events).digest("hex"),
        sizeBytes: events.byteLength,
      },
    ],
  };
  fs.writeFileSync(
    path.join(destinationDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

export function verifyTraceExport(destinationDirectory: string): string[] {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(destinationDirectory, "manifest.json"), "utf8"),
  ) as TraceExportManifest;
  const failures: string[] = [];
  for (const entry of manifest.files) {
    const absolutePath = path.resolve(destinationDirectory, entry.path);
    const root = `${path.resolve(destinationDirectory)}${path.sep}`;
    if (!absolutePath.startsWith(root)) {
      failures.push(`Unsafe export path: ${entry.path}`);
      continue;
    }
    if (!fs.existsSync(absolutePath)) {
      failures.push(`Missing export file: ${entry.path}`);
      continue;
    }
    const content = fs.readFileSync(absolutePath);
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== entry.sha256) {
      failures.push(`Hash mismatch: ${entry.path}`);
    }
  }
  return failures;
}
