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
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "tool_calls",
          toolCalls: [
            { id: "lookup-1", function: { name: "lookup", arguments: {} } },
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
