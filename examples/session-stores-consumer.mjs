import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSessionStore,
  InMemorySessionStore,
} from "@propio-ai/agent/sessions";
import { RunTraceRecorder } from "@propio-ai/agent/trace";
import { AgentSession } from "@propio-ai/agent/agent-core";

const root = mkdtempSync(join(tmpdir(), "propio-stores-"));
try {
  for (const store of [
    new InMemorySessionStore(),
    new FileSessionStore(root),
  ]) {
    const identity = {
      owner: "application-user",
      workspace: "project",
      sessionId: "conversation",
    };
    const handle = store.open(identity);
    handle.snapshots.save({
      content: JSON.stringify({ messages: ["hello"] }),
      savedAt: new Date().toISOString(),
    });
    const session = new AgentSession({
      eventLog: handle.events,
      runTurn: async () => "hello",
    });
    session.dispatch({ type: "submit", commandId: "one", text: "hello" });
    await session.settled();
    assert.ok(handle.events.after(0).length > 0);
    assert.deepEqual(JSON.parse(handle.snapshots.load().content), {
      messages: ["hello"],
    });
    const recorder = new RunTraceRecorder(
      { sessionId: identity.sessionId, runId: "run" },
      handle.traces,
    );
    recorder.record({
      component: "consumer",
      type: "completed",
      payload: { ok: true },
    });
    assert.equal(handle.traces.read("run")[0].payload.ok, true);
    assert.deepEqual(handle.traces.list(), ["run"]);
    assert.equal(store.latest(identity)?.sessionId, "conversation");
    assert.equal(
      store.open({ ...identity, owner: "another-user" }).snapshots.load(),
      undefined,
    );
  }
  console.log("Session store consumer passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
