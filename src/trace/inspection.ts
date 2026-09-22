import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readTraceJournal } from "./journal.js";
import { redactTraceValue } from "./redaction.js";
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

function inspectEvents(
  events: ReadonlyArray<TraceEventEnvelope>,
  warnings: ReadonlyArray<TraceReadWarning>,
  options: TraceInspectionOptions,
): TraceInspection {
  const first = events[0];
  const last = events[events.length - 1];
  const operations = summarizeOperations(events);
  const captureComplete =
    warnings.length === 0 &&
    operations.every((operation) => operation.outcome !== "unknown");
  return {
    eventCount: events.length,
    firstObservedAt: first?.observedAt,
    lastObservedAt: last?.observedAt,
    sessionId: first?.identity.sessionId,
    runId: first?.identity.runId,
    previousRunId: first?.identity.previousRunId,
    captureComplete,
    warnings,
    operations,
    providerMeasurements: summarizeProviderMeasurements(events, {
      pricingResolver: options.pricingResolver,
      captureComplete,
    }),
  };
}

export function inspectTraceJournal(
  journalPath: string,
  options: TraceInspectionOptions = {},
): TraceInspection {
  const { events, warnings } = readTraceJournal(journalPath);
  return inspectEvents(events, warnings, options);
}

interface TraceExportManifestBase {
  readonly exportedAt: string;
  readonly captureLevel: "standard";
  readonly sessionId?: string;
  readonly runId?: string;
  readonly previousRunId?: string;
  readonly captureComplete: boolean;
  readonly warnings: ReadonlyArray<TraceReadWarning>;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }>;
}

export interface TraceExportManifestV1 extends TraceExportManifestBase {
  readonly version: 1;
}

export interface TraceExportManifestV2 extends TraceExportManifestBase {
  readonly version: 2;
  readonly providerMeasurements: ProviderMeasurementSummary;
}

export interface TraceExportMaterial {
  readonly kind:
    | "journal"
    | "tool_result"
    | "prompt_artifact"
    | "provider_payload"
    | "workspace_baseline"
    | "workspace_diff";
  readonly status: "included" | "omitted" | "missing" | "pruned";
  readonly eventId?: string;
  readonly referenceId?: string;
  readonly path?: string;
  readonly reason?: string;
}

export interface TraceExportManifestV3 extends TraceExportManifestBase {
  readonly version: 3;
  readonly eventCount: number;
  readonly operations: ReadonlyArray<TraceOperationSummary>;
  readonly providerMeasurements: ProviderMeasurementSummary;
  readonly revisions: {
    readonly configurationIds: ReadonlyArray<string>;
    readonly promptIds: ReadonlyArray<string>;
    readonly packages?: Record<string, unknown>;
  };
  readonly material: ReadonlyArray<TraceExportMaterial>;
  readonly completenessWarnings: ReadonlyArray<string>;
}

export type TraceExportManifest =
  TraceExportManifestV1 | TraceExportManifestV2 | TraceExportManifestV3;

function payloadRecord(event: TraceEventEnvelope): Record<string, unknown> {
  return event.payload !== null && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
}

function packageMetadata(
  event: TraceEventEnvelope,
): Record<string, unknown> | undefined {
  const configuration = payloadRecord(event).configuration;
  if (configuration === null || typeof configuration !== "object")
    return undefined;
  const packages = (configuration as Record<string, unknown>).packages;
  if (packages === null || typeof packages !== "object") return undefined;
  return redactTraceValue(packages) as Record<string, unknown>;
}

function uniqueIdentityValues(
  events: ReadonlyArray<TraceEventEnvelope>,
  key: "configurationRevisionId" | "promptRevisionId",
): string[] {
  return [
    ...new Set(events.map((event) => event.identity[key]).filter(isString)),
  ];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function exportRevisions(events: ReadonlyArray<TraceEventEnvelope>) {
  const packages = events
    .map(packageMetadata)
    .find((value) => value !== undefined);
  return {
    configurationIds: uniqueIdentityValues(events, "configurationRevisionId"),
    promptIds: uniqueIdentityValues(events, "promptRevisionId"),
    ...(packages === undefined ? {} : { packages }),
  };
}

function eventMaterial(event: TraceEventEnvelope): TraceExportMaterial[] {
  if (
    event.type === "tool_execution_completed" ||
    event.type === "tool_execution_failed"
  ) {
    return [
      {
        kind: "tool_result",
        status: "omitted",
        eventId: event.eventId,
        referenceId: event.identity.toolCallId,
        reason: "raw_tool_output_excluded_by_standard_capture",
      },
    ];
  }
  if (event.type === "provider_request_dispatched") {
    return [
      {
        kind: "provider_payload",
        status: "omitted",
        eventId: event.eventId,
        reason: "request_and_response_bodies_excluded_by_standard_capture",
      },
    ];
  }
  return [];
}

function promptArtifactMaterial(
  event: TraceEventEnvelope,
  seenArtifacts: Set<string>,
): TraceExportMaterial[] {
  if (event.type !== "prompt_plan_selected") return [];
  const ids = payloadRecord(event).includedArtifactIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter(isString).flatMap((id) => {
    if (seenArtifacts.has(id)) return [];
    seenArtifacts.add(id);
    return [
      {
        kind: "prompt_artifact" as const,
        status: "omitted" as const,
        referenceId: id,
        eventId: event.eventId,
        reason: "raw_prompt_artifact_excluded_by_standard_capture",
      },
    ];
  });
}

function omittedArtifactMaterial(
  event: TraceEventEnvelope,
  seenArtifacts: Set<string>,
): TraceExportMaterial[] {
  if (event.type !== "prompt_plan_selected") return [];
  const omissions = payloadRecord(event).omissions;
  if (!Array.isArray(omissions)) return [];
  return omissions.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== "object") return [];
    const omission = entry as Record<string, unknown>;
    if (
      omission.kind !== "artifact" ||
      !isString(omission.id) ||
      seenArtifacts.has(omission.id)
    )
      return [];
    seenArtifacts.add(omission.id);
    const pruned =
      isString(omission.reason) && omission.reason.includes("prun");
    return [
      {
        kind: "prompt_artifact" as const,
        status: pruned ? ("pruned" as const) : ("omitted" as const),
        referenceId: omission.id,
        eventId: event.eventId,
        reason: pruned
          ? "artifact_pruned_before_prompt"
          : "artifact_omitted_from_prompt",
      },
    ];
  });
}

function exportMaterial(
  events: ReadonlyArray<TraceEventEnvelope>,
): TraceExportMaterial[] {
  const material: TraceExportMaterial[] = [
    { kind: "journal", status: "included", path: "events.jsonl" },
  ];
  const seenArtifacts = new Set<string>();
  for (const event of events) {
    material.push(...eventMaterial(event));
    material.push(...promptArtifactMaterial(event, seenArtifacts));
    material.push(...omittedArtifactMaterial(event, seenArtifacts));
  }
  material.push(
    {
      kind: "workspace_baseline",
      status: "missing",
      reason: "workspace_snapshot_not_recorded",
    },
    {
      kind: "workspace_diff",
      status: "missing",
      reason: "workspace_diff_not_recorded",
    },
  );
  return material;
}

export function exportTraceJournal(
  journalPath: string,
  destinationDirectory: string,
  options: TraceInspectionOptions = {},
): TraceExportManifestV3 {
  const snapshot = readTraceJournal(journalPath);
  const safeEvents = snapshot.events.map(
    (event) => redactTraceValue(event) as TraceEventEnvelope,
  );
  const safeWarnings = snapshot.warnings.map((warning) => ({
    type: warning.type,
    line: warning.line,
    message: "Malformed JSONL record",
  }));
  const inspection = inspectEvents(safeEvents, safeWarnings, options);
  const events = Buffer.from(
    safeEvents.map((event) => `${JSON.stringify(event)}\n`).join(""),
  );
  fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  const relativeEventsPath = "events.jsonl";
  fs.writeFileSync(
    path.join(destinationDirectory, relativeEventsPath),
    events,
    {
      mode: 0o600,
    },
  );
  const material = exportMaterial(safeEvents);
  const manifest: TraceExportManifestV3 = {
    version: 3,
    exportedAt: new Date().toISOString(),
    captureLevel: "standard",
    sessionId: inspection.sessionId,
    runId: inspection.runId,
    previousRunId: inspection.previousRunId,
    captureComplete: inspection.captureComplete,
    warnings: inspection.warnings,
    eventCount: inspection.eventCount,
    operations: inspection.operations,
    providerMeasurements: inspection.providerMeasurements,
    revisions: exportRevisions(safeEvents),
    material,
    completenessWarnings: [
      ...(inspection.captureComplete
        ? []
        : ["journal_or_operations_incomplete"]),
      "workspace_baseline_and_diff_not_recorded",
    ],
    files: [
      {
        path: relativeEventsPath,
        sha256: createHash("sha256").update(events).digest("hex"),
        sizeBytes: events.byteLength,
      },
    ],
  };
  const safeManifest = redactTraceValue(manifest) as TraceExportManifestV3;
  fs.writeFileSync(
    path.join(destinationDirectory, "manifest.json"),
    `${JSON.stringify(safeManifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return safeManifest;
}

function version3Failures(manifest: TraceExportManifestV3): string[] {
  const failures: string[] = [];
  if (!Array.isArray(manifest.operations))
    failures.push("Missing operations in version 3 manifest");
  if (!Array.isArray(manifest.material))
    failures.push("Missing material in version 3 manifest");
  if (!manifest.revisions)
    failures.push("Missing revisions in version 3 manifest");
  if (Array.isArray(manifest.material)) {
    for (const item of manifest.material) {
      if (
        item.status === "included" &&
        (!item.path || !manifest.files.some((file) => file.path === item.path))
      ) {
        failures.push(`Unlisted included material: ${item.kind}`);
      }
    }
  }
  return failures;
}

function supportedManifestVersion(version: unknown): version is 1 | 2 | 3 {
  return version === 1 || version === 2 || version === 3;
}

function manifestFailures(manifest: TraceExportManifest): string[] {
  if (!manifest || typeof manifest !== "object")
    return ["Invalid export manifest"];
  if (!supportedManifestVersion(manifest.version))
    return [
      `Unsupported export manifest version: ${String((manifest as { version: unknown }).version)}`,
    ];
  const failures: string[] = [];
  if (manifest.version !== 1 && !manifest.providerMeasurements)
    failures.push(
      `Missing provider measurements in version ${manifest.version} manifest`,
    );
  if (!Array.isArray(manifest.files))
    return [...failures, "Missing export file list"];
  if (manifest.version === 3) failures.push(...version3Failures(manifest));
  return failures;
}

function unsafeFilePath(root: string, filePath: string): boolean {
  const absolutePath = path.resolve(root, filePath);
  const relativePath = path.relative(root, absolutePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  )
    return true;
  if (!fs.existsSync(absolutePath)) return false;
  return (
    fs.lstatSync(absolutePath).isSymbolicLink() ||
    !fs.realpathSync(absolutePath).startsWith(`${root}${path.sep}`)
  );
}

function verifyExportFile(
  root: string,
  entry: TraceExportManifest["files"][number],
): string[] {
  if (
    !entry ||
    typeof entry.path !== "string" ||
    typeof entry.sha256 !== "string" ||
    typeof entry.sizeBytes !== "number"
  )
    return ["Invalid export file entry"];
  if (unsafeFilePath(root, entry.path))
    return [`Unsafe export path: ${entry.path}`];
  const absolutePath = path.resolve(root, entry.path);
  if (!fs.existsSync(absolutePath))
    return [`Missing export file: ${entry.path}`];
  const content = fs.readFileSync(absolutePath);
  const failures: string[] = [];
  if (content.byteLength !== entry.sizeBytes)
    failures.push(`Size mismatch: ${entry.path}`);
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== entry.sha256)
    failures.push(`Hash mismatch: ${entry.path}`);
  return failures;
}

export function verifyTraceExport(destinationDirectory: string): string[] {
  let manifest: TraceExportManifest;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(destinationDirectory, "manifest.json"), "utf8"),
    ) as TraceExportManifest;
  } catch {
    return ["Unreadable export manifest"];
  }
  const failures = manifestFailures(manifest);
  if (!manifest || !Array.isArray(manifest.files)) return failures;
  const root = fs.realpathSync(destinationDirectory);
  return [
    ...failures,
    ...manifest.files.flatMap((entry) => verifyExportFile(root, entry)),
  ];
}
