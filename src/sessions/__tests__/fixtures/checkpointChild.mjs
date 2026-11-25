import * as fs from "node:fs";
import * as path from "node:path";
import { createTestAgent } from "../../../__tests__/testHelpers.ts";
import { AgentSession } from "../../../agent-core/session.ts";
const [directory, boundary] = process.argv.slice(2);
const agent = createTestAgent(
  {
    name: "fixture",
    getCapabilities: () => ({ contextWindowTokens: 32000 }),
    async *streamChat() {
      yield {
        delta: "",
        toolCalls: ["completed", "pending"].map((id) => ({
          id,
          function: { name: "counted", arguments: { id } },
        })),
      };
    },
  },
  { sessionsDir: directory, mcpConfig: { mcpServers: {} } },
);
agent.addTool({
  name: "counted",
  description: "Count a real invocation",
  getSchema: () => ({
    type: "function",
    function: {
      name: "counted",
      description: "Count",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  }),
  async execute({ id }) {
    if (id === "pending" && boundary === "completed") {
      process.send("completed");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    fs.appendFileSync(path.join(directory, "invocations"), `${id}\n`);
    if (id === "pending") {
      process.send("pending");
      await new Promise(() => {});
    }
    return "durable completed result";
  },
});
await agent.initialize();
fs.writeFileSync(path.join(directory, "original.json"), agent.exportSession());
const session = new AgentSession({
  eventLog: agent.getSessionEventLog(),
  runTurn: (submission, control) =>
    agent.streamChat(submission, () => {}, {
      guidance: control.guidance,
      onEvent: control.emit,
    }),
});
session.subscribeProtocol((event) => agent.recordSessionProtocol(event));
session.subscribe((event) => {
  if (event.type === "tool_started" && event.toolCallId === "pending") {
    session.dispatch({
      type: "guide",
      commandId: "queued-1",
      text: "first queued",
    });
    session.dispatch({
      type: "guide",
      commandId: "queued-2",
      text: "second queued",
    });
  }
});
session.dispatch({
  type: "submit",
  commandId: "task",
  text: "original user task",
});
