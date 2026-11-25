import type { ProtocolEvent, SessionEventLog } from "../agent-core/protocol.js";
import type { TraceEventEnvelope, TraceSink } from "../trace/types.js";

/** Opaque, host-selected identities. Workspace is not discovered or normalized. */
export interface SessionScope {
  readonly owner: string;
  readonly workspace: string;
}

export interface SessionStoreIdentity extends SessionScope {
  readonly sessionId: string;
}

/** Content is encoded by the host (for example, the existing CLI context codec). */
export interface SessionSnapshot {
  readonly content: string;
  readonly savedAt: string;
}

export interface SessionSnapshotStore {
  load(): SessionSnapshot | undefined;
  save(snapshot: SessionSnapshot): void;
}

export interface SessionProtocolStore extends SessionEventLog {
  after(sequence: number): readonly ProtocolEvent[];
}

/** Standard redaction applies to both adapters; private material is not captured. */
export interface SessionTraceStore extends TraceSink {
  read(runId: string): readonly TraceEventEnvelope[];
  list(): readonly string[];
}

export interface SessionStoreHandle {
  readonly identity: SessionStoreIdentity;
  readonly snapshots: SessionSnapshotStore;
  readonly events: SessionProtocolStore;
  readonly traces: SessionTraceStore;
}

export interface SessionStoreEntry {
  readonly sessionId: string;
  readonly snapshot?: SessionSnapshot;
}

/** Synchronous stores match AgentSession's event log and the trace sink contract.
 * Hosts own writer serialization. Implementations must detach caller-owned data.
 */
export interface SessionStore {
  open(identity: SessionStoreIdentity): SessionStoreHandle;
  list(scope: SessionScope): readonly SessionStoreEntry[];
  latest(scope: SessionScope): SessionStoreEntry | undefined;
}
