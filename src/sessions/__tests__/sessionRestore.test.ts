import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatRequest } from "@propio-ai/providers";
import { createTestAgent } from "../../__tests__/testHelpers.js";
import { ContextManager } from "../../context/contextManager.js";
import { parseSession, serializeSession } from "../../context/persistence.js";
import { createProtocolEvent } from "../../agent-core/protocol.js";
import {
  readRecoveryJournal,
  writeRecoveryJournalBase,
} from "../recoveryJournal.js";

it("restores structured context, mode, grants and ordered undelivered input without leaking to another session", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "session-restore-"));
  const requests: ChatRequest[] = [];
  const provider = {
    name: "fixture",
    getCapabilities: () => ({ contextWindowTokens: 32000 }),
    async *streamChat(request: ChatRequest) {
      requests.push(request);
      yield { delta: "continued" };
    },
  };
  const agent = createTestAgent(provider, {
    sessionsDir: directory,
    mcpConfig: { mcpServers: {} },
  });
  try {
    await agent.initialize();
    const empty = agent.exportSession();
    const metadata = parseSession(empty).metadata;
    const context = new ContextManager();
    context.beginUserTurn("earlier user message");
    context.commitAssistantResponse("", [
      {
        id: "committed-call",
        function: { name: "read", arguments: { path: "README.md" } },
      },
    ]);
    context.recordToolResults([
      {
        toolCallId: "committed-call",
        toolName: "read",
        status: "success",
        rawContent: "committed tool result",
      },
    ]);
    context.appendOperatorGuidance("delivered guidance");
    context.commitAssistantResponse("earlier answer");
    writeRecoveryJournalBase(
      directory,
      serializeSession(context.getConversationState(), {
        ...metadata,
        agentMode: "discover",
        sessionGrants: ["bash"],
        pendingGuidance: [
          { id: "one", text: "first waiting" },
          { id: "two", text: "second waiting" },
        ],
      }),
    );
    await agent.importSessionWithWriter(empty);
    expect(agent.getAgentMode()).toBe("discover");
    expect(parseSession(agent.exportSession()).metadata.sessionGrants).toEqual([
      "bash",
    ]);
    expect(agent.takeRecoveredGuidance()).toEqual([
      "first waiting",
      "second waiting",
    ]);
    expect(agent.takeRecoveredGuidance()).toEqual([]);
    await agent.streamChat({ text: "continue" }, () => {});
    const messages = requests[0]!.messages;
    const toolResults = messages.flatMap(
      (message) => message.toolResults ?? [],
    );
    for (const text of [
      "earlier user message",
      "committed tool result",
      "delivered guidance",
    ]) {
      expect(
        [...messages, ...toolResults].filter((message) =>
          message.content?.includes(text),
        ),
      ).toHaveLength(1);
    }
    expect(
      toolResults.filter((result) => result.toolCallId === "committed-call"),
    ).toHaveLength(1);
    const other = JSON.parse(empty);
    other.metadata.sessionId = "different-session";
    await agent.importSessionWithWriter(JSON.stringify(other));
    expect(agent.getConversationState().turns).toHaveLength(0);
    expect(agent.getAgentMode()).toBe("execute");
    expect(
      parseSession(agent.exportSession()).metadata.sessionGrants,
    ).toBeUndefined();
    expect(agent.takeRecoveredGuidance()).toEqual([]);
  } finally {
    await agent.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("reconciles guidance recorded beyond the checkpoint once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guidance-restore-"));
  const agent = createTestAgent(
    {
      name: "fixture",
      getCapabilities: () => ({ contextWindowTokens: 32000 }),
      async *streamChat() {
        yield { delta: "unused" };
      },
    },
    { sessionsDir: directory, mcpConfig: { mcpServers: {} } },
  );
  try {
    await agent.initialize();
    const context = new ContextManager();
    context.beginUserTurn("original task");
    const baseline = serializeSession(context.getConversationState(), {
      ...parseSession(agent.exportSession()).metadata,
      protocolSequence: 0,
    });
    writeRecoveryJournalBase(directory, baseline);
    const log = agent.getSessionEventLog()!;
    log.append(
      createProtocolEvent(1, {
        type: "guidance_queued",
        id: "delivered",
        text: "historical guidance",
      }),
    );
    log.append(
      createProtocolEvent(2, {
        type: "guidance_delivered",
        id: "delivered",
        text: "historical guidance",
        iteration: 1,
      }),
    );
    log.append(
      createProtocolEvent(3, {
        type: "guidance_queued",
        id: "waiting",
        text: "still waiting",
      }),
    );
    await agent.importSessionWithWriter(baseline);
    expect(agent.getReplayCoverageWarning()).toMatch(
      /after its conversation checkpoint/,
    );
    agent.importSession(agent.exportSession());
    const guidance = agent
      .getConversationState()
      .turns[0]!.entries.filter((entry) => entry.kind === "guidance");
    expect(guidance).toHaveLength(1);
    expect(guidance[0]!.message.content).toContain("historical guidance");
    expect(agent.takeRecoveredGuidance()).toEqual(["still waiting"]);
  } finally {
    await agent.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps conversation checkpoints when protocol sequence inspection fails", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "checkpoint-log-fault-"),
  );
  let requestCount = 0;
  const agent = createTestAgent(
    {
      name: "fixture",
      getCapabilities: () => ({ contextWindowTokens: 32000 }),
      async *streamChat() {
        if (++requestCount === 1) {
          yield {
            delta: "",
            toolCalls: [
              { id: "result", function: { name: "fixture", arguments: {} } },
            ],
          };
        } else yield { delta: "done" };
      },
    },
    { sessionsDir: directory, mcpConfig: { mcpServers: {} } },
  );
  agent.addTool({
    name: "fixture",
    description: "fixture",
    getSchema: () => ({
      type: "function",
      function: {
        name: "fixture",
        description: "fixture",
        parameters: { type: "object", properties: {} },
      },
    }),
    execute: async () => "result survives a protocol fault",
  });
  try {
    await agent.initialize();
    Object.defineProperty(agent.getSessionEventLog()!, "lastSequence", {
      get() {
        throw new Error("injected protocol read failure");
      },
    });
    await agent.streamChat({ text: "keep this conversation" }, () => {});
    expect(
      readRecoveryJournal(directory, agent.getRuntimeSessionId())!.json,
    ).toContain("result survives a protocol fault");
    expect(agent.getReplayCoverageWarning()).toMatch(
      /recovery remains available/,
    );
  } finally {
    await agent.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
