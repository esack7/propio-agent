import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  FileSessionStore,
  InMemorySessionStore,
  type SessionStore,
} from "../index.js";
import { parseProtocolEvent } from "../../agent-core/protocol.js";
import type { TraceEventEnvelope } from "../../trace/types.js";

const scope = { owner: "owner/a", workspace: "/work/project" };
const identity = { ...scope, sessionId: "shared" };
const event = (seq: number) =>
  parseProtocolEvent({
    seq,
    event: { type: "custom", value: { text: `event-${seq}` } },
  });
const trace = (text: string): TraceEventEnvelope => ({
  version: 1,
  eventId: "event",
  sequence: 1,
  observedAt: "2026-01-01T00:00:00Z",
  monotonicNanoseconds: "0",
  component: "test",
  type: "custom",
  identity: { sessionId: "shared", runId: "run" },
  payload: { text, apiKey: "private-key" },
});

for (const adapter of ["memory", "file"] as const) {
  describe(`${adapter} session store contract`, () => {
    let directory: string;
    let store: SessionStore;
    beforeEach(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), "session-contract-"));
      store =
        adapter === "memory"
          ? new InMemorySessionStore()
          : new FileSessionStore(directory);
    });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    it("isolates identical session and run IDs by owner and workspace", () => {
      const identities = [
        identity,
        { ...identity, owner: "owner/b" },
        { ...identity, workspace: "/work/other" },
      ];
      identities.forEach((id, index) => {
        const handle = store.open(id);
        expect(handle.snapshots.load()).toBeUndefined();
        expect(handle.events.after(0)).toEqual([]);
        expect(handle.traces.read("run")).toEqual([]);
        handle.snapshots.save({
          content: `conversation-${index}`,
          savedAt: "2026-01-01T00:00:00Z",
        });
        handle.events.append(
          parseProtocolEvent({
            seq: 1,
            event: { type: "custom", value: index },
          }),
        );
        handle.traces.record(trace(`trace-${index}`));
      });
      identities.forEach((id, index) => {
        const handle = store.open(id);
        expect(handle.snapshots.load()?.content).toBe(`conversation-${index}`);
        expect(handle.events.after(0)[0].event).toEqual({
          type: "custom",
          value: index,
        });
        expect(handle.traces.read("run")[0].payload).toMatchObject({
          text: `trace-${index}`,
        });
        expect(store.list(id).map((entry) => entry.sessionId)).toEqual([
          "shared",
        ]);
        expect(store.latest(id)?.snapshot?.content).toBe(
          `conversation-${index}`,
        );
      });
      expect(store.list({ ...scope, owner: "missing" })).toEqual([]);
    });

    it("shares reopened handles, enforces sequences and reads strictly after cursors", () => {
      const handle = store.open(identity);
      expect(handle.events.lastSequence).toBeUndefined();
      handle.events.append(event(7)); // recording may begin after legacy history
      handle.events.append(event(8));
      const reopened =
        adapter === "file" ? new FileSessionStore(directory) : store;
      const log = reopened.open(identity).events;
      expect(log.lastSequence).toBe(8);
      expect(log.after(7).map((record) => record.seq)).toEqual([8]);
      expect(log.after(0).map((record) => record.seq)).toEqual([7, 8]);
      expect(log.after(100)).toEqual([]);
      expect(() => log.append(event(10))).toThrow("contiguous");
      expect(() => log.append(event(8))).toThrow("contiguous");
      for (const cursor of [-1, 0.5, NaN, Infinity])
        expect(() => log.after(cursor)).toThrow();
      log.append(event(9));
      expect(handle.events.lastSequence).toBe(9);
    });

    it("selects latest snapshots by time with stable ID ties and detaches data", () => {
      const saved = { content: "original", savedAt: "2026-01-01T00:00:00Z" };
      store.open(identity).snapshots.save(saved);
      saved.content = "mutated";
      const loaded = store.open(identity).snapshots.load()!;
      expect(loaded.content).toBe("original");
      (loaded as { content: string }).content = "changed";
      expect(store.open(identity).snapshots.load()?.content).toBe("original");
      for (const sessionId of ["z", "a"])
        store.open({ ...identity, sessionId }).snapshots.save({
          content: sessionId,
          savedAt: "2026-02-01T00:00:00Z",
        });
      store
        .open({ ...identity, sessionId: "events-only" })
        .events.append(event(1));
      expect(store.latest(scope)?.sessionId).toBe("a");
      expect(store.list(scope).map((entry) => entry.sessionId)).toEqual([
        "a",
        "events-only",
        "shared",
        "z",
      ]);
    });

    it("keeps traces readable, detached, redacted and bound to the session", () => {
      const handle = store.open(identity);
      const input = trace("before");
      handle.traces.record(input, { durable: true });
      (input.payload as { text: string }).text = "after";
      expect(handle.traces.list()).toEqual(["run"]);
      expect(handle.traces.read("run")[0].payload).toEqual({
        text: "before",
        apiKey: "[REDACTED]",
      });
      const read = handle.traces.read("run");
      (read[0].payload as { text: string }).text = "mutated";
      expect(handle.traces.read("run")[0].payload).toMatchObject({
        text: "before",
      });
      expect(() =>
        handle.traces.record({
          ...input,
          identity: { sessionId: "other", runId: "run" },
        }),
      ).toThrow("identity");
    });

    it("rejects unsafe identifiers and invalid snapshots before writing", () => {
      for (const sessionId of ["../escape", "/absolute", "a/b", "..", ""])
        expect(() => store.open({ ...identity, sessionId })).toThrow();
      const handle = store.open(identity);
      expect(() =>
        handle.snapshots.save({ content: "bad", savedAt: "invalid" }),
      ).toThrow();
      expect(() => handle.traces.read("../run")).toThrow();
      expect(handle.snapshots.load()).toBeUndefined();
      expect(store.latest(scope)).toBeUndefined();
    });
  });
}

it("supports a standalone consumer through the package's named public exports", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "session-consumer-"));
  const root = process.cwd();
  try {
    fs.copyFileSync(
      path.join(root, "package.json"),
      path.join(directory, "package.json"),
    );
    fs.copyFileSync(
      path.join(root, "examples/session-stores-consumer.mjs"),
      path.join(directory, "consumer.mjs"),
    );
    fs.symlinkSync(
      path.join(root, "node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    execFileSync(
      process.execPath,
      [
        path.join(root, "node_modules/typescript/bin/tsc"),
        "--project",
        path.join(root, "tsconfig.json"),
        "--outDir",
        path.join(directory, "dist"),
      ],
      { stdio: "pipe" },
    );
    expect(
      execFileSync(process.execPath, [path.join(directory, "consumer.mjs")], {
        encoding: "utf8",
      }),
    ).toContain("Session store consumer passed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 120000);

it("refuses linked file storage paths and creates private session data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "session-paths-"));
  try {
    const root = path.join(directory, "store");
    const store = new FileSessionStore(root);
    const handle = store.open(identity);
    handle.snapshots.save({ content: "first", savedAt: "2026-01-01" });
    handle.snapshots.save({ content: "second", savedAt: "2026-01-02" });
    expect(
      new FileSessionStore(root).open(identity).snapshots.load()?.content,
    ).toBe("second");
    const owner = path.join(root, fs.readdirSync(root)[0]);
    const workspace = path.join(owner, fs.readdirSync(owner)[0]);
    const session = path.join(workspace, identity.sessionId);
    const snapshotPath = path.join(session, "snapshot.json");
    if (process.platform !== "win32") {
      expect(fs.statSync(snapshotPath).mode & 0o077).toBe(0);
      expect(fs.statSync(session).mode & 0o077).toBe(0);
    }
    const outside = path.join(directory, "outside.json");
    fs.writeFileSync(outside, "untouched");
    fs.unlinkSync(snapshotPath);
    fs.symlinkSync(outside, snapshotPath);
    expect(() => handle.snapshots.load()).toThrow("Unsafe");
    expect(() =>
      handle.snapshots.save({ content: "bad", savedAt: "2026-01-03" }),
    ).toThrow("Unsafe");
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    fs.unlinkSync(snapshotPath);
    fs.rmSync(session, { recursive: true });
    fs.symlinkSync(directory, session, "dir");
    expect(() => handle.events.append(event(1))).toThrow("Unsafe");
    expect(() => store.list(scope)).toThrow("Unsafe");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
