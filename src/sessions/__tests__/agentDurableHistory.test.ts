import { createCliTurnSession } from "../../cli/turnSession.js";
import { TerminalUi } from "../../ui/terminal.js";
import { createTtyTestStream } from "../../ui/__tests__/ttyTestStream.js";
import {
  JsonlTraceJournal,
  RunTraceRecorder,
  readTraceJournal,
} from "../../trace/index.js";
import type { Agent } from "../../agent.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestAgent } from "../../__tests__/testHelpers.js";
import { createProtocolEvent } from "../../agent-core/protocol.js";
import { AgentSession } from "../../agent-core/session.js";
import { handleSessionCommand } from "../sessionCommands.js";
import { writeSnapshot } from "../sessionHistory.js";

let directory: string;
const agents: Agent[] = [];
function makeAgent(): Agent {
  const agent = createTestAgent(
    {
      name: "fixture",
      getCapabilities: () => ({ contextWindowTokens: 32000 }),
      async *streamChat() {
        throw new Error("Replay must not call the provider");
      },
    },
    { sessionsDir: directory, mcpConfig: { mcpServers: {} } },
  );
  agents.push(agent);
  return agent;
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-history-"));
});
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("keeps the current writer usable when loading a busy session fails", async () => {
  const first = makeAgent();
  const second = makeAgent();
  await first.initialize();
  await second.initialize();
  const current = second.getRuntimeSessionId();
  await expect(
    second.importSessionWithWriter(first.exportSession()),
  ).rejects.toThrow(/already open for writing/);
  expect(second.getRuntimeSessionId()).toBe(current);
  second.getSessionEventLog()!.append(
    createProtocolEvent(1, {
      type: "assistant_text",
      delta: "still writable",
    }),
  );
  expect(second.getSessionEventLog()!.lastSequence).toBe(1);
});

it("rejects checkpoints beyond the log, including a reload of the current session", async () => {
  const agent = makeAgent();
  await agent.initialize();
  const snapshot = JSON.parse(agent.exportSession());
  snapshot.metadata.protocolSequence = 10;
  await expect(
    agent.importSessionWithWriter(JSON.stringify(snapshot)),
  ).rejects.toThrow(/checkpoint exceeds/);
  snapshot.metadata.sessionId = "another-session";
  await expect(
    agent.importSessionWithWriter(JSON.stringify(snapshot)),
  ).rejects.toThrow(/checkpoint exceeds/);
  expect(agent.getSessionEventLog()!.lastSequence).toBeUndefined();
});

it("retains legacy coverage and identity after recording and reopening through session load", async () => {
  const original = makeAgent();
  const legacy = JSON.parse(original.exportSession());
  delete legacy.metadata.sessionId;
  delete legacy.metadata.protocolSequence;
  delete legacy.metadata.protocolStartTurnIndex;
  const now = new Date().toISOString();
  legacy.context.turns = [1, 2, 3].map((index) => ({
    id: `legacy-turn-${index}`,
    startedAt: now,
    completedAt: now,
    importance: "normal",
    userMessage: { role: "user", content: `Earlier ${index}` },
    entries: [
      {
        kind: "assistant",
        createdAt: now,
        message: { role: "assistant", content: `Earlier answer ${index}` },
      },
    ],
  }));
  await original.initialize();
  await original.importSessionWithWriter(JSON.stringify(legacy));
  const identity = original.getRuntimeSessionId();
  expect(identity).toMatch(/^legacy-[a-f0-9]{64}$/);
  const session = new AgentSession({
    eventLog: original.getSessionEventLog(),
    runTurn: async (_submission, control) => {
      control.emit({ type: "assistant_text", delta: "recorded continuation" });
      return "recorded continuation";
    },
  });
  session.dispatch({ type: "submit", commandId: "continue", text: "Continue" });
  await session.settled();
  const entry = writeSnapshot(directory, original.exportSession());
  await original.close();
  const next = makeAgent();
  await next.initialize();
  const messages: string[] = [];
  const replayed: unknown[] = [];
  await handleSessionCommand(
    `/session load ${entry.sessionId}`,
    next,
    directory,
    {
      info: (message) => messages.push(message),
      error: (message) => {
        throw new Error(message);
      },
      command: () => {},
      success: () => {},
      promptConfirm: async () => true,
      replay: (records) => replayed.push(...records),
    },
  );
  expect(next.getRuntimeSessionId()).toBe(identity);
  expect(messages.join(" ")).toMatch(/first 3 snapshot turns/);
  expect(replayed).toEqual(original.getSessionEventLog()!.after(0));
  expect(next.getSessionEventLog()!.lastSequence).toBeGreaterThan(1);
});

it("records CLI turns without resetting the durable cursor and correlates trace events", async () => {
  const journals: string[] = [];
  const agent = createTestAgent(
    {
      name: "fixture",
      getCapabilities: () => ({ contextWindowTokens: 32000 }),
      async *streamChat() {
        yield { delta: "recorded answer" };
      },
    },
    {
      sessionsDir: directory,
      mcpConfig: { mcpServers: {} },
      createTraceRun: (identity) => {
        const filename = path.join(directory, `${identity.runId}.jsonl`);
        journals.push(filename);
        const journal = new JsonlTraceJournal(filename);
        return {
          recorder: new RunTraceRecorder(identity, journal),
          close: () => journal.close(),
        };
      },
    },
  );
  agents.push(agent);
  await agent.initialize();
  const ui = new TerminalUi({
    interactive: false,
    plain: true,
    json: true,
    stdout: createTtyTestStream(false, 80),
    stderr: createTtyTestStream(false, 80),
  });
  const turns = createCliTurnSession(agent, ui, {
    showToolCalls: true,
    showThinking: false,
    showStatus: false,
    showReasoningSummary: false,
    showContextStats: false,
    showPromptPlan: false,
  });
  await turns.runTurn({ text: "First" }, new AbortController().signal);
  const cursor = agent.getSessionEventLog()!.lastSequence!;
  await turns.runTurn({ text: "Second" }, new AbortController().signal);
  const records = agent.getSessionEventLog()!.after(cursor);
  expect(records[0].seq).toBe(cursor + 1);
  expect(records.some(({ event }) => event.type === "assistant_text")).toBe(
    true,
  );
  await agent.close();
  const correlated = journals
    .flatMap((filename) => readTraceJournal(filename).events)
    .filter((event) => event.type === "session_protocol");
  expect(correlated.length).toBeGreaterThan(0);
  const protocol = agent.getSessionEventLog()!.after(0);
  for (const event of correlated) {
    expect(event.identity.sessionId).toBe(agent.getRuntimeSessionId());
    expect(protocol).toContainEqual(
      expect.objectContaining({
        seq: (event.payload as { sessionSequence: number }).sessionSequence,
      }),
    );
  }
});
