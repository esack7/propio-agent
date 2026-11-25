import { parseProtocolEvent } from "../agent-core/protocol.js";
import type { ProtocolEvent } from "../agent-core/protocol.js";
import { redactTraceValue } from "../trace/redaction.js";
import type { TraceEventEnvelope } from "../trace/types.js";
import { isSafeSessionId } from "./sessionId.js";
import type {
  SessionScope,
  SessionSnapshot,
  SessionStore,
  SessionStoreHandle,
  SessionStoreIdentity,
} from "./stores.js";

export interface StoreBackend {
  read(key: string): string | undefined;
  replace(key: string, content: string): void;
  append(key: string, content: string): void;
  list(prefix: string): string[];
}

function validateScope(scope: SessionScope): void {
  if (typeof scope.owner !== "string" || typeof scope.workspace !== "string")
    throw new TypeError("Owner and workspace must be strings");
}

function validateId(id: string): void {
  if (typeof id !== "string" || !isSafeSessionId(id))
    throw new TypeError("Invalid session or run ID");
}

function snapshot(value: SessionSnapshot): SessionSnapshot {
  if (
    typeof value.content !== "string" ||
    typeof value.savedAt !== "string" ||
    !Number.isFinite(Date.parse(value.savedAt))
  )
    throw new TypeError("Invalid session snapshot");
  return { content: value.content, savedAt: value.savedAt };
}

function records(backend: StoreBackend, key: string): unknown[] {
  const content = backend.read(key);
  if (!content) return [];
  return content
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function protocolRecords(backend: StoreBackend): ProtocolEvent[] {
  const events = records(backend, "events.jsonl").map(parseProtocolEvent);
  events.forEach((event, index) => {
    if (index > 0 && event.seq !== events[index - 1].seq + 1)
      throw new Error("Event log sequence must be contiguous");
  });
  return events;
}

function createHandle(
  identity: SessionStoreIdentity,
  backend: StoreBackend,
): SessionStoreHandle {
  const load = () => {
    const content = backend.read("snapshot.json");
    return content === undefined ? undefined : snapshot(JSON.parse(content));
  };
  return {
    identity: Object.freeze({ ...identity }),
    snapshots: {
      load,
      save: (value) =>
        backend.replace("snapshot.json", JSON.stringify(snapshot(value))),
    },
    events: {
      get lastSequence() {
        const events = protocolRecords(backend);
        return events[events.length - 1]?.seq;
      },
      append(value) {
        // Roundtrip also validates records created by the trusted runtime helper.
        const event = parseProtocolEvent(JSON.parse(JSON.stringify(value)));
        const events = protocolRecords(backend);
        const previous = events[events.length - 1];
        if (previous && event.seq !== previous.seq + 1)
          throw new Error("Event log sequence must be contiguous");
        backend.append("events.jsonl", `${JSON.stringify(event)}\n`);
      },
      after(sequence) {
        if (!Number.isSafeInteger(sequence) || sequence < 0)
          throw new RangeError("Invalid event cursor");
        return protocolRecords(backend).filter((event) => event.seq > sequence);
      },
    },
    traces: {
      captureLevel: "standard",
      record(event) {
        validateId(event.identity.runId);
        if (event.identity.sessionId !== identity.sessionId)
          throw new Error("Trace session identity does not match store handle");
        const content = JSON.stringify(redactTraceValue(event));
        backend.append(`traces/${event.identity.runId}.jsonl`, `${content}\n`);
      },
      read(runId) {
        validateId(runId);
        return records(
          backend,
          `traces/${runId}.jsonl`,
        ) as TraceEventEnvelope[];
      },
      list: () =>
        backend
          .list("traces/")
          .map((key) => key.slice(7, -6))
          .sort(),
    },
  };
}

/** Shared behavior for storage adapters; no process-global session state. */
export abstract class ScopedSessionStore implements SessionStore {
  protected abstract backend(identity: SessionStoreIdentity): StoreBackend;
  protected abstract sessionIds(scope: SessionScope): string[];

  open(value: SessionStoreIdentity): SessionStoreHandle {
    validateScope(value);
    validateId(value.sessionId);
    const identity = {
      owner: value.owner,
      workspace: value.workspace,
      sessionId: value.sessionId,
    };
    return createHandle(identity, this.backend(identity));
  }

  list(scope: SessionScope) {
    validateScope(scope);
    return this.sessionIds(scope)
      .sort()
      .map((sessionId) => {
        const saved = this.open({ ...scope, sessionId }).snapshots.load();
        return { sessionId, ...(saved ? { snapshot: saved } : {}) };
      });
  }

  latest(scope: SessionScope) {
    return this.list(scope)
      .filter((entry) => entry.snapshot)
      .sort(
        (a, b) =>
          Date.parse(b.snapshot!.savedAt) - Date.parse(a.snapshot!.savedAt) ||
          a.sessionId.localeCompare(b.sessionId),
      )[0];
  }
}

export class InMemorySessionStore extends ScopedSessionStore {
  private readonly data = new Map<string, Map<string, string>>();

  protected backend(identity: SessionStoreIdentity): StoreBackend {
    const key = JSON.stringify([
      identity.owner,
      identity.workspace,
      identity.sessionId,
    ]);
    const current = () => this.data.get(key);
    const write = (name: string, content: string) => {
      let files = current();
      if (!files) this.data.set(key, (files = new Map()));
      files.set(name, content);
    };
    return {
      read: (name) => current()?.get(name),
      replace: write,
      append: (name, content) =>
        write(name, (current()?.get(name) ?? "") + content),
      list: (prefix) =>
        [...(current()?.keys() ?? [])].filter((name) =>
          name.startsWith(prefix),
        ),
    };
  }

  protected sessionIds(scope: SessionScope): string[] {
    return [...this.data.keys()]
      .map((key) => JSON.parse(key) as string[])
      .filter(
        ([owner, workspace]) =>
          owner === scope.owner && workspace === scope.workspace,
      )
      .map(([, , sessionId]) => sessionId);
  }
}
