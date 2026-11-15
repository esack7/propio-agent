import {
  AgentSession,
  parseProtocolEvent,
  type ProtocolEvent,
} from "../../agent-core/index.js";
import type { AgentVisibilityEvent } from "../../agent.js";
import type { ToolDisplay } from "../../tools/display.js";
import {
  createCliTurnSession,
  answerApprovalsThrough,
} from "../../cli/turnSession.js";
import { formatApprovalRequest } from "../approvalPrompt.js";
import { TerminalUi } from "../terminal.js";
import { replaySession } from "../replaySession.js";
import { createTtyTestStream } from "./ttyTestStream.js";
import type { AssistantTurnAgent } from "../assistantTurnRenderer.js";

const visibility = {
  showToolCalls: true,
  showThinking: false,
  showStatus: false,
  showReasoningSummary: true,
  showContextStats: false,
  showPromptPlan: false,
};
function terminal() {
  const stdout = createTtyTestStream(false, 80);
  const stderr = createTtyTestStream(false, 80);
  const ui = new TerminalUi({
    interactive: false,
    plain: true,
    json: false,
    stdout,
    stderr,
  });
  return { ui, text: () => stdout.chunks.join("") + stderr.chunks.join("") };
}
const diff: ToolDisplay = {
  title: "Editing a.ts",
  body: {
    kind: "diff",
    path: "a.ts",
    operation: "replace",
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          { op: "-", text: "old" },
          { op: "+", text: "new" },
        ],
      },
    ],
    added: 1,
    removed: 1,
    truncated: false,
  },
};
const command: ToolDisplay = {
  title: "Running checks",
  body: { kind: "command", command: "check", truncated: false },
};
const generic: ToolDisplay = {
  title: "Calling mcp__records",
  body: {
    kind: "generic",
    fields: [{ key: "id", value: "42" }],
    resultPreview: "record found",
    truncated: false,
  },
};

it.each([true, false])(
  "replays a mixed CLI turn, including approval, denial and guidance (tools=%s)",
  async (showToolCalls) => {
    const live = terminal();
    const settings = { ...visibility, showToolCalls };
    let session: AgentSession<unknown>;
    let executions = 0;
    const agent: AssistantTurnAgent = {
      streamChat: async (_submission, onToken, options) => {
        const emit = (event: AgentVisibilityEvent) => options?.onEvent?.(event);
        const call = async (
          id: string,
          toolName: string,
          display: ToolDisplay,
          approval = false,
        ) => {
          emit({
            type: "tool_started",
            toolCallId: id,
            toolName,
            display,
            args: {},
            argumentChars: 2,
          });
          if (approval) {
            const answer = await session.approvalChannel.request({
              id,
              toolCallId: id,
              toolName,
              display,
              args: {},
              capabilities: ["workspace_write"],
              reason: "ask",
              rule: "mode:ask",
              suggestions: [],
            });
            if (answer.decision === "deny") {
              emit({
                type: "tool_failed",
                toolCallId: id,
                toolName,
                display: { ...display, error: "denied" },
                durationMs: 0,
              });
              return;
            }
          }
          executions++;
          if (id === "command") {
            emit({
              type: "tool_output",
              toolCallId: id,
              stream: "stderr",
              text: "failing...\n",
              droppedBytes: 0,
              elapsedMs: 5,
              transient: true,
            });
            emit({
              type: "tool_failed",
              toolCallId: id,
              toolName,
              display: {
                title: display.title,
                body: {
                  ...command.body,
                  kind: "command",
                  command: "check",
                  truncated: false,
                  stderrTail: "failed",
                  exitCode: 2,
                  classification: "nonzero_exit",
                },
              },
              durationMs: 25,
            });
          } else
            emit({
              type: "tool_finished",
              toolCallId: id,
              toolName,
              display,
              durationMs: 10,
            });
        };
        onToken("Working on it.\n");
        await call("edit", "edit", diff, true);
        await call("command", "bash", command);
        for (let i = 0; i < 3; i++)
          await call(`read-${i}`, "read", {
            title: `Reading ${i}.ts`,
            body: { kind: "file_read", path: `${i}.ts`, lines: 10 },
          });
        await call("mcp", "mcp__records", generic);
        session.dispatch({
          type: "guide",
          commandId: "guidance",
          text: "Use staging.",
        });
        for (const message of options?.guidance?.drain() ?? [])
          emit({ type: "guidance_delivered", ...message, iteration: 2 });
        await call("deny", "edit", diff, true);
        onToken("Done.");
        return "Done.";
      },
      getLastTurnReasoningSummary: () => ({
        summary: "Checked the files",
        source: "agent",
      }),
      getConversationState: () => {
        throw new Error("not requested");
      },
    };
    const turns = createCliTurnSession(agent, live.ui, settings);
    session = turns.session as AgentSession<unknown>;
    const log: ProtocolEvent[] = [];
    const approvals =
      (ui: TerminalUi) =>
      ({ event }: ProtocolEvent) => {
        if (event.type === "approval_requested")
          for (const line of formatApprovalRequest(
            event.request,
            event.request.display,
            80,
          ))
            ui.subtle(line);
      };
    turns.session.subscribeProtocol((event) => {
      log.push(event);
      approvals(live.ui)(event);
    });
    answerApprovalsThrough(turns.session, {
      request: async (request) => ({
        requestId: request.id,
        decision: request.id === "deny" ? "deny" : "allow_once",
      }),
    });
    await turns.runTurn({ text: "Do the work" }, new AbortController().signal);
    expect(executions).toBe(6);
    expect(log.map((event) => event.seq)).toEqual(
      log.map((_, index) => index + 1),
    );
    expect(log.some(({ event }) => event.type === "tool_output")).toBe(true);
    expect(
      log
        .filter(({ event }) => event.type === "approval_resolved")
        .map(
          ({ event }) => event.type === "approval_resolved" && event.resolution,
        ),
    ).toEqual(["allow_once", "deny"]);
    const decoded = JSON.parse(JSON.stringify(log));
    for (const event of decoded)
      expect(parseProtocolEvent(event)).toEqual(event);
    const replay = terminal();
    replaySession(decoded, replay.ui, settings, {
      skipTransient: true,
      onEvent: approvals(replay.ui),
    });
    expect(replay.text()).toBe(live.text());
    expect(replay.text()).toContain("Use staging.");
    expect(replay.text()).toContain("needs approval");
    expect(executions).toBe(6);
  },
);

it("rejects a malformed or reordered recording before writing output", () => {
  const { ui, text } = terminal();
  for (const values of [
    [
      { seq: 1, event: { type: "assistant_text", delta: "hello" } },
      { seq: 2, event: { type: "bad" } },
    ],
    [
      { seq: 2, event: { type: "turn_started" } },
      { seq: 1, event: { type: "turn_started" } },
    ],
  ])
    expect(() => replaySession(values, ui, visibility)).toThrow();
  expect(text()).toBe("");
});

it.each([false, true])(
  "replays failed/cancelled turns and a later successful turn (%s)",
  async (cancelled) => {
    const live = terminal();
    const abort = new AbortController();
    const failure = new TypeError("original error identity");
    let first = true;
    const agent: AssistantTurnAgent = {
      streamChat: async (_submission, onToken) => {
        onToken("Partial answer.");
        if (first) {
          first = false;
          if (cancelled) abort.abort("escape");
          throw failure;
        }
        return "Partial answer.";
      },
      getLastTurnReasoningSummary: () => null,
      getConversationState: () => {
        throw new Error("not requested");
      },
    };
    const turns = createCliTurnSession(agent, live.ui, visibility);
    const log: ProtocolEvent[] = [];
    turns.session.subscribeProtocol((event) => log.push(event));
    await expect(turns.runTurn({ text: "first" }, abort.signal)).rejects.toBe(
      failure,
    );
    await turns.runTurn({ text: "second" }, new AbortController().signal);
    expect(
      log.some(
        ({ event }) =>
          event.type === (cancelled ? "turn_cancelled" : "turn_failed"),
      ),
    ).toBe(true);
    const replay = terminal();
    replaySession(JSON.parse(JSON.stringify(log)), replay.ui, visibility);
    expect(replay.text()).toBe(live.text());
  },
);
