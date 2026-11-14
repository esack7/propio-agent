import { TerminalUi } from "../terminal.js";
import { ReplUiStore } from "../replUi.js";
import { streamAssistantTurn } from "../assistantTurnRenderer.js";
import type { AgentVisibilityEvent } from "../../agent.js";
import { createTtyTestStream, stripAnsi } from "./ttyTestStream.js";
import type { ToolCallDisplay } from "../toolCallDisplay.js";

const call: ToolCallDisplay = {
  id: "a",
  toolName: "bash",
  status: "success",
  durationMs: 1000,
  display: {
    title: "bash",
    body: {
      kind: "command",
      command: "printf lines",
      stdoutTail: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
      truncated: false,
      exitCode: 0,
    },
  },
};
function harness(plain = false, json = false) {
  const stdout = createTtyTestStream();
  const stderr = createTtyTestStream();
  const ui = new TerminalUi({
    interactive: !plain,
    plain,
    json,
    stdout,
    stderr,
  });
  return { ui, stderr, stdout };
}

it("keeps every running call in order and removes only the completed one", () => {
  const store = new ReplUiStore();
  store.upsertToolCallDisplay({ ...call, status: "running" });
  store.upsertToolCallDisplay({ ...call, id: "b", status: "running" });
  expect([...store.getState().toolCallDisplays.keys()]).toEqual(["a", "b"]);
  store.upsertToolCallDisplay(call);
  expect([...store.getState().toolCallDisplays.keys()]).toEqual(["b"]);
});
it.each([false, true])(
  "expands hidden lines and the escaped full-output path (plain=%s)",
  (plain) => {
    const { ui, stderr } = harness(plain);
    ui.renderToolCall({ ...call, fullOutputPath: "/tmp/full\x1b[2J.txt" });
    const collapsed = stripAnsi(stderr.chunks.join(""));
    expect(collapsed).toContain("line 29");
    expect(collapsed).not.toContain("line 0\n");
    stderr.chunks.length = 0;
    ui.expandLastToolCall();
    const expanded = stripAnsi(stderr.chunks.join(""));
    expect(expanded).toContain("line 0");
    expect(expanded).toContain("line 29");
    expect(expanded).toContain("/tmp/full\\x1b[2J.txt");
    ui.cleanup();
  },
);
it("emits nothing in JSON mode and reports an empty expansion in plain mode", () => {
  const { ui, stderr, stdout } = harness(false, true);
  ui.renderToolCall(call);
  ui.expandLastToolCall();
  expect(stderr.chunks.join("") + stdout.chunks.join("")).toBe("");
  const plain = harness(true);
  plain.ui.expandLastToolCall();
  expect(plain.stderr.chunks.join("")).toContain("No tool result to expand");
});
it("renders identical completed calls with thinking visible or hidden", async () => {
  const outputs: string[][] = [];
  for (const showThinking of [false, true]) {
    const { ui } = harness();
    const render = jest.spyOn(ui, "renderToolCall");
    const event = (
      type: "tool_started" | "tool_finished",
    ): AgentVisibilityEvent =>
      type === "tool_started"
        ? {
            type,
            toolCallId: "a",
            toolName: "bash",
            display: call.display,
            args: {},
            argumentChars: 0,
          }
        : {
            type,
            toolCallId: "a",
            toolName: "bash",
            display: call.display,
            durationMs: 1000,
          };
    await streamAssistantTurn(
      {
        streamChat: async (_submission, token, options) => {
          options?.onEvent?.({ type: "thinking_delta", delta: "reasoning" });
          options?.onEvent?.(event("tool_started"));
          options?.onEvent?.(event("tool_finished"));
          token("done");
          return "done";
        },
        getLastTurnReasoningSummary: () => null,
        getConversationState: jest.fn(),
      },
      { text: "test" },
      ui,
      new AbortController().signal,
      {
        showThinking,
        showToolCalls: true,
        showStatus: false,
        showReasoningSummary: false,
        showContextStats: false,
        showPromptPlan: false,
      },
    );
    outputs.push(render.mock.calls.map(([view]) => JSON.stringify(view)));
    expect(
      render.mock.calls.filter(([view]) => view.status === "success"),
    ).toHaveLength(1);
    ui.cleanup();
  }
  expect(outputs[0]).toEqual(outputs[1]);
});

it("clears the prior running row before appending a completed result", () => {
  const { ui, stderr } = harness();
  ui.renderToolCall({
    ...call,
    status: "running",
    display: { title: "Reading", body: { kind: "file_read", path: "a" } },
  });
  stderr.chunks.length = 0;
  ui.renderToolCall({
    ...call,
    display: {
      title: "Reading",
      body: { kind: "file_read", path: "a", lines: 1 },
    },
  });
  const output = stderr.chunks.join("");
  expect(output.indexOf("\x1b[1A")).toBeGreaterThanOrEqual(0);
  expect(output.indexOf("\x1b[1A")).toBeLessThan(output.indexOf("Reading"));
  ui.cleanup();
});
