import { randomUUID } from "node:crypto";
import type {
  AgentTraceRecorder,
  TraceEventEnvelope,
  TraceEventInput,
  TraceIdentity,
  TraceRecordOptions,
  TraceSink,
} from "./types.js";

/** Allocates ordered envelopes for one run and delegates storage to an injected sink. */
export class RunTraceRecorder implements AgentTraceRecorder {
  private sequence = 0;
  readonly identity: TraceIdentity;

  constructor(
    identity: TraceIdentity,
    private readonly sink: TraceSink,
  ) {
    this.identity = { ...identity };
  }

  record(event: TraceEventInput, options?: TraceRecordOptions): void {
    const envelope: TraceEventEnvelope = {
      version: 1,
      eventId: randomUUID(),
      sequence: ++this.sequence,
      observedAt: new Date().toISOString(),
      monotonicNanoseconds: process.hrtime.bigint().toString(),
      component: event.component,
      type: event.type,
      identity: { ...this.identity, ...event.identity },
      payload: event.payload,
    };
    this.sink.record(envelope, options);
  }
}
