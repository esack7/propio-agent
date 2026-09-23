import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readTraceJournal } from "./journal.js";
import { redactTraceValue } from "./redaction.js";
import {
  summarizeProviderMeasurements,
  type ProviderMeasurementSummary,
  type ProviderPricingResolver,
} from "./measurements.js";
import type {
  TraceEventEnvelope,
  TraceMaterialReference,
  TraceReadWarning,
} from "./types.js";

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
  /** Full exports include private, content-addressed material captured with the run. */
  readonly captureLevel?: "standard" | "full";
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
  readonly captureLevel: "standard" | "full";
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
  readonly captureLevel: "standard";
}

export interface TraceExportManifestV2 extends TraceExportManifestBase {
  readonly version: 2;
  readonly captureLevel: "standard";
  readonly providerMeasurements: ProviderMeasurementSummary;
}

export interface TraceExportMaterial {
  readonly kind:
    | "journal"
    | "tool_result"
    | "tool_arguments"
    | "prompt_artifact"
    | "provider_payload"
    | "workspace_baseline"
    | "workspace_diff";
  readonly status: "included" | "partial" | "omitted" | "missing" | "pruned";
  readonly eventId?: string;
  readonly referenceId?: string;
  readonly path?: string;
  readonly reason?: string;
}

export interface TraceExportManifestV3 extends TraceExportManifestBase {
  readonly version: 3;
  readonly captureLevel: "standard";
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

export type TraceExportManifestV4 = Omit<
  TraceExportManifestV3,
  "version" | "captureLevel"
> & { readonly version: 4; readonly captureLevel: "full" };

export type TraceExportManifest =
  | TraceExportManifestV1
  | TraceExportManifestV2
  | TraceExportManifestV3
  | TraceExportManifestV4;

export interface TraceExportInspection extends TraceInspection {
  readonly manifest: TraceExportManifest;
}

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
  return packages as Record<string, unknown>;
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
        ...(event.identity.toolCallId === undefined
          ? {}
          : { referenceId: event.identity.toolCallId }),
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
): TraceExportMaterial[] {
  if (event.type !== "prompt_plan_selected") return [];
  const ids = payloadRecord(event).includedArtifactIds;
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter(isString))].map((id) => ({
    kind: "prompt_artifact" as const,
    status: "omitted" as const,
    referenceId: id,
    eventId: event.eventId,
    reason: "raw_prompt_artifact_excluded_by_standard_capture",
  }));
}

function omittedArtifactMaterial(
  event: TraceEventEnvelope,
): TraceExportMaterial[] {
  if (event.type !== "prompt_plan_selected") return [];
  const omissions = payloadRecord(event).omissions;
  if (!Array.isArray(omissions)) return [];
  const seenInEvent = new Set<string>();
  return omissions.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== "object") return [];
    const omission = entry as Record<string, unknown>;
    if (
      omission.kind !== "artifact" ||
      !isString(omission.id) ||
      seenInEvent.has(omission.id)
    )
      return [];
    seenInEvent.add(omission.id);
    const pruned = omission.reasonCode === "artifact_pruned";
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
  warnings: ReadonlyArray<TraceReadWarning>,
): TraceExportMaterial[] {
  const material: TraceExportMaterial[] = [
    {
      kind: "journal",
      status: warnings.length === 0 ? "included" : "partial",
      path: "events.jsonl",
      ...(warnings.length === 0
        ? {}
        : { reason: "source_journal_had_invalid_lines" }),
    },
  ];
  for (const event of events) {
    material.push(...eventMaterial(event));
    material.push(...promptArtifactMaterial(event));
    material.push(...omittedArtifactMaterial(event));
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

interface CapturedMaterial {
  readonly kind: TraceExportMaterial["kind"];
  readonly eventId: string;
  readonly referenceId?: string;
  readonly ref?: TraceMaterialReference;
}

function capturedMaterial(
  events: ReadonlyArray<TraceEventEnvelope>,
): CapturedMaterial[] {
  const captures: CapturedMaterial[] = [];
  for (const event of events) {
    const payload = payloadRecord(event);
    const fields: ReadonlyArray<{
      type: string;
      key: string;
      kind: TraceExportMaterial["kind"];
    }> = [
      {
        type: "provider_request_dispatched",
        key: "requestMaterial",
        kind: "provider_payload",
      },
      {
        type: "provider_response_captured",
        key: "responseMaterial",
        kind: "provider_payload",
      },
      {
        type: "tool_execution_started",
        key: "argumentMaterial",
        kind: "tool_arguments",
      },
      {
        type: "tool_execution_completed",
        key: "resultMaterial",
        kind: "tool_result",
      },
      {
        type: "tool_execution_failed",
        key: "resultMaterial",
        kind: "tool_result",
      },
      {
        type: "workspace_baseline_captured",
        key: "material",
        kind: "workspace_baseline",
      },
      {
        type: "workspace_diff_captured",
        key: "material",
        kind: "workspace_diff",
      },
    ];
    for (const field of fields) {
      if (event.type !== field.type) continue;
      captures.push({
        kind: field.kind,
        eventId: event.eventId,
        referenceId: event.identity.toolCallId,
        ref: materialReference(payload[field.key]),
      });
    }
  }
  return captures;
}

function materialReference(value: unknown): TraceMaterialReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const ref = value as Partial<TraceMaterialReference>;
  if (!validMaterialReferenceFields(ref) || !validMaterialReferencePath(ref))
    return undefined;
  return ref as TraceMaterialReference;
}

function validMaterialReferenceFields(
  ref: Partial<TraceMaterialReference>,
): boolean {
  return (
    typeof ref.path === "string" &&
    typeof ref.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(ref.sha256) &&
    Number.isSafeInteger(ref.sizeBytes) &&
    (ref.sizeBytes ?? -1) >= 0 &&
    (ref.encoding === "json" || ref.encoding === "binary")
  );
}

function validMaterialReferencePath(
  ref: Partial<TraceMaterialReference>,
): boolean {
  if (!ref.path || !ref.sha256 || !ref.encoding) return false;
  return (
    /^[A-Za-z0-9-]+\.materials\/[a-f0-9]{64}\.(json|bin)$/.test(ref.path) &&
    ref.path.endsWith(
      `${ref.sha256}.${ref.encoding === "json" ? "json" : "bin"}`,
    )
  );
}

function findMaterialReferences(value: unknown): TraceMaterialReference[] {
  const found: TraceMaterialReference[] = [];
  function visit(entry: unknown): void {
    const ref = materialReference(entry);
    if (ref) {
      found.push(ref);
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
    } else if (entry && typeof entry === "object") {
      for (const child of Object.values(entry)) visit(child);
    }
  }
  visit(value);
  return found;
}

function materialGraph(
  root: string,
  events: ReadonlyArray<TraceEventEnvelope>,
): CapturedMaterial[] {
  const captures = capturedMaterial(events);
  const pending = [...captures];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const capture = pending.shift()!;
    const ref = capture.ref;
    if (!ref || seen.has(ref.path)) continue;
    seen.add(ref.path);
    for (const child of readNestedMaterialReferences(root, ref)) {
      const nested = {
        kind: capture.kind,
        eventId: capture.eventId,
        referenceId: child.sha256,
        ref: child,
      };
      captures.push(nested);
      pending.push(nested);
    }
  }
  return captures;
}

function readNestedMaterialReferences(
  root: string,
  ref: TraceMaterialReference,
): TraceMaterialReference[] {
  if (ref.encoding !== "json") return [];
  const bytes = readVerifiedMaterial(root, ref);
  if (!bytes) return [];
  try {
    return findMaterialReferences(JSON.parse(bytes.toString("utf8")));
  } catch {
    return [];
  }
}

function fullExportMaterial(
  root: string,
  events: ReadonlyArray<TraceEventEnvelope>,
  warnings: ReadonlyArray<TraceReadWarning>,
  files: TraceExportManifestBase["files"],
): TraceExportMaterial[] {
  const material: TraceExportMaterial[] = [
    {
      kind: "journal",
      status: warnings.length === 0 ? "included" : "partial",
      path: "events.jsonl",
      ...(warnings.length === 0
        ? {}
        : { reason: "source_journal_had_invalid_lines" }),
    },
  ];
  const partialEvents = new Set(
    events
      .filter(
        (event) =>
          Number(payloadRecord(event).omissionCount) > 0 ||
          (event.type === "provider_response_captured" &&
            payloadRecord(event).completed === false),
      )
      .map((event) => event.eventId),
  );
  material.push(
    ...materialGraph(root, events).map((capture) =>
      fullMaterialEntry(capture, files, partialEvents),
    ),
  );
  if (!material.some((entry) => entry.kind === "workspace_baseline")) {
    material.push({
      kind: "workspace_baseline",
      status: "missing",
      reason: "workspace_snapshot_not_recorded",
    });
  }
  if (!material.some((entry) => entry.kind === "workspace_diff")) {
    material.push({
      kind: "workspace_diff",
      status: "missing",
      reason: "workspace_diff_not_recorded",
    });
  }
  return material;
}

function fullMaterialEntry(
  capture: CapturedMaterial,
  files: TraceExportManifestBase["files"],
  partialEvents: ReadonlySet<string>,
): TraceExportMaterial {
  return {
    kind: capture.kind,
    eventId: capture.eventId,
    ...(capture.referenceId ? { referenceId: capture.referenceId } : {}),
    ...fullMaterialStatus(capture, files, partialEvents),
  };
}

function fullMaterialStatus(
  capture: CapturedMaterial,
  files: TraceExportManifestBase["files"],
  partialEvents: ReadonlySet<string>,
): Pick<TraceExportMaterial, "status" | "path" | "reason"> {
  const ref = capture.ref;
  if (
    !ref ||
    !files.some((file) => file.path === ref.path && file.sha256 === ref.sha256)
  )
    return { status: "missing", reason: "private_capture_unavailable" };
  if (capture.referenceId === undefined && partialEvents.has(capture.eventId))
    return {
      status: "partial",
      path: ref.path,
      reason: "captured_material_incomplete_or_omitted",
    };
  return { status: "included", path: ref.path };
}

function completenessWarnings(
  captureComplete: boolean,
  material?: ReadonlyArray<TraceExportMaterial>,
): string[] {
  return material === undefined
    ? [
        ...(captureComplete ? [] : ["journal_or_operations_incomplete"]),
        "workspace_baseline_and_diff_not_recorded",
      ]
    : [
        ...(captureComplete ? [] : ["journal_or_operations_incomplete"]),
        ...(material.some(
          (entry) => entry.status === "missing" || entry.status === "partial",
        )
          ? ["full_material_incomplete"]
          : []),
      ];
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function exportEvent(
  event: TraceEventEnvelope,
  captureLevel: "standard" | "full",
): TraceEventEnvelope {
  const safe = redactTraceValue(event) as TraceEventEnvelope;
  if (captureLevel === "full") return safe;
  if (
    safe.payload === null ||
    typeof safe.payload !== "object" ||
    Array.isArray(safe.payload)
  )
    return safe;
  const payload = { ...payloadRecord(safe) };
  for (const key of [
    "requestMaterial",
    "responseMaterial",
    "argumentMaterial",
    "resultMaterial",
    "material",
  ]) {
    delete payload[key];
  }
  return { ...safe, payload };
}

function copyCapturedMaterials(
  journalPath: string,
  destinationDirectory: string,
  events: ReadonlyArray<TraceEventEnvelope>,
): TraceExportManifestBase["files"] {
  const sourceRoot = fs.realpathSync(path.dirname(journalPath));
  const destinationRoot = fs.realpathSync(destinationDirectory);
  const copied = new Map<string, TraceExportManifestBase["files"][number]>();
  for (const { ref } of materialGraph(sourceRoot, events)) {
    if (!ref || copied.has(ref.path)) continue;
    const bytes = readVerifiedMaterial(sourceRoot, ref);
    if (!bytes) continue;
    writeExportMaterial(destinationRoot, ref, bytes);
    copied.set(ref.path, {
      path: ref.path,
      sha256: ref.sha256,
      sizeBytes: ref.sizeBytes,
    });
  }
  return [...copied.values()];
}

function readVerifiedMaterial(
  root: string,
  ref: TraceMaterialReference,
): Buffer | undefined {
  if (unsafeFilePath(root, ref.path)) return undefined;
  const file = path.join(root, ref.path);
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return undefined;
  const bytes = fs.readFileSync(file);
  return bytes.length === ref.sizeBytes && sha256(bytes) === ref.sha256
    ? bytes
    : undefined;
}

function writeExportMaterial(
  root: string,
  ref: TraceMaterialReference,
  bytes: Buffer,
): void {
  const destination = path.join(root, ref.path);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!fs.realpathSync(parent).startsWith(`${root}${path.sep}`))
    throw new Error("Unsafe material export directory");
  if (fs.existsSync(destination)) {
    if (
      unsafeFilePath(root, ref.path) ||
      sha256(fs.readFileSync(destination)) !== ref.sha256
    )
      throw new Error("Existing export material does not match its hash");
  } else {
    fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  }
}

export function exportTraceJournal(
  journalPath: string,
  destinationDirectory: string,
  options: TraceInspectionOptions = {},
): TraceExportManifestV3 | TraceExportManifestV4 {
  const snapshot = readTraceJournal(journalPath);
  const captureLevel = options.captureLevel ?? "standard";
  const safeEvents = snapshot.events.map((event) =>
    exportEvent(event, captureLevel),
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
  const full = captureLevel === "full";
  const files = [
    {
      path: relativeEventsPath,
      sha256: sha256(events),
      sizeBytes: events.byteLength,
    },
    ...(full
      ? copyCapturedMaterials(journalPath, destinationDirectory, safeEvents)
      : []),
  ];
  const material = full
    ? fullExportMaterial(
        fs.realpathSync(destinationDirectory),
        safeEvents,
        inspection.warnings,
        files,
      )
    : exportMaterial(safeEvents, inspection.warnings);
  const commonManifest = {
    exportedAt: new Date().toISOString(),
    sessionId: inspection.sessionId,
    runId: inspection.runId,
    previousRunId: inspection.previousRunId,
    captureComplete:
      inspection.captureComplete &&
      (!full || material.every((entry) => entry.status === "included")),
    warnings: inspection.warnings,
    eventCount: inspection.eventCount,
    operations: inspection.operations,
    providerMeasurements: inspection.providerMeasurements,
    revisions: exportRevisions(safeEvents),
    material,
    completenessWarnings: completenessWarnings(
      inspection.captureComplete,
      full ? material : undefined,
    ),
    files,
  };
  const manifest: TraceExportManifestV3 | TraceExportManifestV4 = full
    ? { ...commonManifest, version: 4, captureLevel: "full" }
    : { ...commonManifest, version: 3, captureLevel: "standard" };
  const safeManifest = redactTraceValue(manifest) as
    TraceExportManifestV3 | TraceExportManifestV4;
  const manifestBytes = Buffer.from(
    `${JSON.stringify(safeManifest, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(destinationDirectory, "manifest.json"),
    manifestBytes,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(destinationDirectory, "manifest.sha256"),
    `${sha256(manifestBytes)}\n`,
    { mode: 0o600 },
  );
  return safeManifest;
}

function materialEntryFailure(
  item: TraceExportMaterial,
  files: TraceExportManifestV3["files"],
): string | undefined {
  if (item === null || typeof item !== "object")
    return "Invalid material entry";
  if (item.status !== "included" && item.status !== "partial") return undefined;
  if (!item.path || !files.some((file) => file?.path === item.path))
    return `Unlisted included material: ${item.kind}`;
  return undefined;
}

function version3Failures(
  manifest: TraceExportManifestV3 | TraceExportManifestV4,
): string[] {
  const failures: string[] = [];
  if (!Array.isArray(manifest.operations))
    failures.push("Missing operations in version 3 manifest");
  if (!Array.isArray(manifest.material))
    failures.push("Missing material in version 3 manifest");
  if (!manifest.revisions)
    failures.push("Missing revisions in version 3 manifest");
  if (Array.isArray(manifest.material)) {
    failures.push(
      ...manifest.material.flatMap((item) => {
        const failure = materialEntryFailure(item, manifest.files);
        return failure ? [failure] : [];
      }),
    );
  }
  return failures;
}

function supportedManifestVersion(version: unknown): version is 1 | 2 | 3 | 4 {
  return version === 1 || version === 2 || version === 3 || version === 4;
}

function manifestFailures(manifest: TraceExportManifest): string[] {
  if (!manifest || typeof manifest !== "object")
    return ["Invalid export manifest"];
  if (!supportedManifestVersion(manifest.version))
    return [
      `Unsupported export manifest version: ${String((manifest as { version: unknown }).version)}`,
    ];
  const failures = manifestMetadataFailures(manifest);
  if (!Array.isArray(manifest.files))
    return [...failures, "Missing export file list"];
  if (manifest.version === 3 || manifest.version === 4)
    failures.push(...version3Failures(manifest));
  return failures;
}

function manifestMetadataFailures(manifest: TraceExportManifest): string[] {
  const failures: string[] = [];
  if (!Array.isArray(manifest.warnings))
    failures.push("Missing manifest warnings");
  if (manifest.version !== 1 && !manifest.providerMeasurements)
    failures.push(
      `Missing provider measurements in version ${manifest.version} manifest`,
    );
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
  const actualHash = sha256(content);
  if (actualHash !== entry.sha256)
    failures.push(`Hash mismatch: ${entry.path}`);
  return failures;
}

function verifyManifestChecksum(
  root: string,
  manifestBytes: Uint8Array,
  required: boolean,
): string[] {
  const checksumPath = path.join(root, "manifest.sha256");
  if (!fs.existsSync(checksumPath))
    return required ? ["Missing manifest checksum"] : [];
  const checksumStat = fs.lstatSync(checksumPath);
  if (checksumStat.isSymbolicLink()) return ["Unsafe manifest checksum path"];
  if (!checksumStat.isFile()) return ["Invalid manifest checksum"];
  const expected = fs.readFileSync(checksumPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(expected)) return ["Invalid manifest checksum"];
  return expected === sha256(manifestBytes)
    ? []
    : ["Manifest checksum mismatch"];
}

function verifyDerivedClaims(
  root: string,
  manifest: TraceExportManifestV3 | TraceExportManifestV4,
): string[] {
  if (!Array.isArray(manifest.warnings)) return ["Invalid manifest warnings"];
  if (unsafeFilePath(root, "events.jsonl"))
    return ["Unsafe export path: events.jsonl"];
  let events: ReadonlyArray<TraceEventEnvelope>;
  try {
    const journal = readTraceJournal(path.join(root, "events.jsonl"));
    if (journal.warnings.length > 0) return ["Malformed exported journal"];
    events = journal.events;
  } catch {
    return ["Unreadable exported journal"];
  }
  try {
    return derivedClaims(root, manifest, events).flatMap(
      ([name, actual, expected]) =>
        isDeepStrictEqual(actual, expected)
          ? []
          : [`Manifest ${name} mismatch`],
    );
  } catch {
    return ["Invalid exported journal events"];
  }
}

function derivedClaims(
  root: string,
  manifest: TraceExportManifestV3 | TraceExportManifestV4,
  events: ReadonlyArray<TraceEventEnvelope>,
): ReadonlyArray<[string, unknown, unknown]> {
  const inspection = inspectEvents(events, manifest.warnings, {});
  const full = manifest.version === 4;
  const material = full
    ? fullExportMaterial(root, events, manifest.warnings, manifest.files)
    : exportMaterial(events, manifest.warnings);
  const captureComplete =
    inspection.captureComplete &&
    (!full || material.every((entry) => entry.status === "included"));
  return [
    ["captureLevel", manifest.captureLevel, full ? "full" : "standard"],
    ["eventCount", manifest.eventCount, inspection.eventCount],
    ["sessionId", manifest.sessionId, inspection.sessionId],
    ["runId", manifest.runId, inspection.runId],
    ["previousRunId", manifest.previousRunId, inspection.previousRunId],
    ["captureComplete", manifest.captureComplete, captureComplete],
    ["operations", manifest.operations, inspection.operations],
    ["revisions", manifest.revisions, exportRevisions(events)],
    ["material", manifest.material, material],
    [
      "completenessWarnings",
      manifest.completenessWarnings,
      completenessWarnings(
        inspection.captureComplete,
        full ? material : undefined,
      ),
    ],
  ];
}

function verifyTraceExportUnchecked(destinationDirectory: string): string[] {
  let manifest: TraceExportManifest;
  let manifestBytes: Buffer;
  try {
    const manifestPath = path.join(destinationDirectory, "manifest.json");
    if (fs.lstatSync(manifestPath).isSymbolicLink())
      return ["Unsafe manifest path"];
    manifestBytes = fs.readFileSync(manifestPath);
    manifest = JSON.parse(
      manifestBytes.toString("utf8"),
    ) as TraceExportManifest;
  } catch {
    return ["Unreadable export manifest"];
  }
  const failures = manifestFailures(manifest);
  if (!manifest || !Array.isArray(manifest.files)) return failures;
  const root = fs.realpathSync(destinationDirectory);
  const checksumFailures = verifyManifestChecksum(
    root,
    manifestBytes,
    manifest.version >= 3,
  );
  const fileFailures = manifest.files.flatMap((entry) =>
    verifyExportFile(root, entry),
  );
  return [
    ...failures,
    ...checksumFailures,
    ...fileFailures,
    ...((manifest.version === 3 || manifest.version === 4) &&
    fileFailures.length === 0
      ? verifyDerivedClaims(root, manifest)
      : []),
  ];
}

export function verifyTraceExport(destinationDirectory: string): string[] {
  try {
    return verifyTraceExportUnchecked(destinationDirectory);
  } catch {
    return ["Unreadable export bundle"];
  }
}

/** Inspect a bundle with its source-journal warnings, not just its valid events. */
export function inspectTraceExport(
  destinationDirectory: string,
  options: TraceInspectionOptions = {},
): TraceExportInspection {
  const failures = verifyTraceExport(destinationDirectory);
  if (failures.length > 0)
    throw new Error(`Trace export verification failed: ${failures.join("; ")}`);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(destinationDirectory, "manifest.json"), "utf8"),
  ) as TraceExportManifest;
  const { events } = readTraceJournal(
    path.join(destinationDirectory, "events.jsonl"),
  );
  const inspection = inspectEvents(events, manifest.warnings, options);
  return {
    ...inspection,
    captureComplete: manifest.captureComplete,
    providerMeasurements:
      manifest.version === 1
        ? inspection.providerMeasurements
        : manifest.providerMeasurements,
    manifest,
  };
}
