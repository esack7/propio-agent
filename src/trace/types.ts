export interface TraceIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly attemptId?: string;
  readonly operationId?: string;
  readonly parentOperationId?: string;
  readonly toolCallId?: string;
  readonly configurationRevisionId?: string;
  readonly promptRevisionId?: string;
  readonly summaryRevisionId?: string;
  readonly policyRevisionId?: string;
  readonly toolScopeRevisionId?: string;
  readonly previousRunId?: string;
}

export interface TraceEventEnvelope<TPayload = unknown> {
  readonly version: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly observedAt: string;
  readonly monotonicNanoseconds: string;
  readonly component: string;
  readonly type: string;
  readonly identity: TraceIdentity;
  readonly payload: TPayload;
}

export interface TraceEventInput<TPayload = unknown> {
  readonly component: string;
  readonly type: string;
  readonly identity?: Partial<TraceIdentity>;
  readonly payload: TPayload;
}

export interface TraceRecordOptions {
  /** Force the event through the configured durable-write barrier. */
  readonly durable?: boolean;
}

export interface TraceMaterialReference {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly encoding: "json" | "binary";
}

export interface TraceSink {
  readonly captureLevel?: "standard" | "full";
  record(event: TraceEventEnvelope, options?: TraceRecordOptions): void;
  /** Optional private, content-addressed capture owned by the sink. */
  captureMaterial?(value: unknown): TraceMaterialReference | undefined;
}

export interface AgentTraceRecorder {
  readonly identity: TraceIdentity;
  readonly captureLevel?: "standard" | "full";
  record(event: TraceEventInput, options?: TraceRecordOptions): void;
  captureMaterial?(value: unknown): TraceMaterialReference | undefined;
}

export interface TraceCaptureFailure {
  readonly journalPath: string;
  readonly operation: "open" | "write" | "flush" | "close" | "material";
  readonly errorName: string;
  readonly message: string;
}

export interface TraceReadWarning {
  readonly type: "truncated_final_line" | "invalid_line";
  readonly line: number;
  readonly message: string;
}

export interface TraceReadResult {
  readonly events: ReadonlyArray<TraceEventEnvelope>;
  readonly warnings: ReadonlyArray<TraceReadWarning>;
}
