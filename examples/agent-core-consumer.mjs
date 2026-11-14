// An in-memory application using only public package entry points; no credentials.
import { AgentRuntime } from "@propio-ai/agent/agent-core";
import { ConversationManager } from "@propio-ai/agent/context";
import { ToolRegistry, createExecutableTool } from "@propio-ai/agent/tools";

const tools = new ToolRegistry();
tools.register(
  createExecutableTool({
    schema: {
      type: "function",
      function: {
        name: "lookup",
        description: "Find an example record",
        parameters: { type: "object" },
      },
    },
    invoke: async () => ({ status: "success", content: "Record 42: ready" }),
  }),
  true,
);
const runtime = new AgentRuntime({
  provider: {
    name: "example",
    getCapabilities: () => ({ contextWindowTokens: 32000 }),
    async *streamChat(request) {
      // Look a record up for each new question; answer once the result, and
      // anything the operator added meanwhile, is in the conversation.
      const last = request.messages.at(-1);
      if (last.role === "user" && !last.content.startsWith("[The operator")) {
        yield {
          type: "tool_calls",
          toolCalls: [
            {
              id: `lookup-${request.messages.length}`,
              function: { name: "lookup", arguments: {} },
            },
          ],
        };
      } else {
        yield { type: "assistant_text", delta: "Record 42 is ready." };
      }
    },
  },
  model: "in-memory",
  context: new ConversationManager(),
  tools,
  systemPrompt: "Answer record questions.",
  policy: {
    maxIterations: 5,
    useNoProgressDetector: true,
    streamIdleTimeoutMs: 1000,
    outputTokenRecoveryLimit: 0,
  },
});
const result = await runtime.streamChat({ text: "Check record 42" }, () => {}, {
  onEvent: (event) => {
    if (event.type === "tool_finished")
      console.log(`Tool result: ${event.result}`);
  },
});
console.log(result);
const cancellation = new AbortController();
cancellation.abort();
try {
  await runtime.streamChat({ text: "Cancelled request" }, () => {}, {
    abortSignal: cancellation.signal,
  });
} catch (error) {
  console.log(error.message);
}

// The same runtime behind a session: everything a frontend does is a command,
// and everything it learns is an event. Both are plain JSON.
import { AgentSession, parseSessionCommand } from "@propio-ai/agent/agent-core";

const session = new AgentSession({
  runTurn: (submission, control) =>
    runtime.streamChat(submission, () => {}, {
      abortSignal: control.abortSignal,
      guidance: control.guidance,
      onEvent: control.emit,
    }),
});
const send = (command) => {
  const parsed = parseSessionCommand(JSON.parse(JSON.stringify(command)));
  return parsed.ok ? session.dispatch(parsed.command) : parsed;
};
const onEvent = {
  // Steer the turn while its tool call is running.
  tool_started: () =>
    send({ type: "guide", commandId: "guide-1", text: "Answer in one word." }),
  guidance_delivered: (event) =>
    console.log(`Guidance delivered: ${event.text}`),
  session_turn_ended: (event) =>
    console.log(`Turn ${event.outcome}: ${event.result}`),
};
session.subscribe((event) => onEvent[event.type]?.(event));
send({ type: "submit", commandId: "submit-1", text: "Check record 7" });
await session.settled();
console.log(JSON.stringify(send({ type: "interrupt", commandId: "late" })));
