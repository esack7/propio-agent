import { describe, expect, it, jest } from "@jest/globals";
import type {
  ChatRequest,
  ChatStreamEvent,
  LLMProvider,
} from "@propio-ai/providers";
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type AgentVisibilityEvent,
} from "../index.js";
import { ConversationManager } from "../../context/index.js";
import {
  ToolRegistry,
  createExecutableTool,
  type ToolDisplay,
  type ToolExecutionResult,
} from "../../tools/index.js";

type ToolEvent = Extract<
  AgentVisibilityEvent,
  { type: "tool_started" | "tool_finished" | "tool_failed" }
>;

function setup(
  integrations: AgentRuntimeOptions["integrations"] = {},
  invoke: (
    args: Record<string, unknown>,
  ) => Promise<ToolExecutionResult> = async (args) => ({
    status: "success",
    content: `result of ${String(args.key)}`,
  }),
  callArgs: Record<string, unknown> = { key: "k" },
) {
  const requests: ChatRequest[] = [];
  const rounds: ChatStreamEvent[][] = [
    [
      {
        type: "tool_calls",
        toolCalls: [
          {
            id: "call-1",
            function: { name: "lookup", arguments: callArgs },
          },
        ],
      },
    ],
    [{ type: "assistant_text", delta: "Done." }],
  ];
  const provider: LLMProvider = {
    name: "test",
    getCapabilities: () => ({ contextWindowTokens: 32000 }),
    async *streamChat(request) {
      const round = rounds[requests.length] ?? rounds[1];
      requests.push(request);
      yield* round;
    },
  };
  const tools = new ToolRegistry();
  const execute = jest.fn(invoke);
  tools.register(
    createExecutableTool({
      schema: {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      invoke: execute,
    }),
    true,
  );
  const runtime = new AgentRuntime({
    provider,
    model: "example",
    context: new ConversationManager(),
    tools,
    systemPrompt: "Answer questions about records.",
    policy: {
      maxIterations: 4,
      useNoProgressDetector: false,
      streamIdleTimeoutMs: 0,
      outputTokenRecoveryLimit: 1,
    },
    integrations,
  });
  const events: AgentVisibilityEvent[] = [];
  const run = () =>
    runtime.streamChat({ text: "Find it" }, () => {}, {
      onEvent: (event) => events.push(event),
    });
  const toolEvents = () =>
    events.filter((event): event is ToolEvent =>
      ["tool_started", "tool_finished", "tool_failed"].includes(event.type),
    );
  return { run, events, toolEvents, execute, requests };
}

const GENERIC_BEFORE: ToolDisplay = {
  title: "lookup",
  body: {
    kind: "generic",
    fields: [{ key: "key", value: "k" }],
    truncated: false,
  },
};

const described = (title: string): ToolDisplay => ({
  title,
  body: { kind: "file_read", path: "a.txt" },
});

describe("display payloads on tool events (a8)", () => {
  it("describes a call generically when the application describes nothing", async () => {
    const { run, toolEvents } = setup();
    await run();

    const [started, finished] = toolEvents();
    expect(started).toMatchObject({
      type: "tool_started",
      display: GENERIC_BEFORE,
    });
    expect(finished).toMatchObject({
      type: "tool_finished",
      display: {
        title: "lookup",
        body: { ...GENERIC_BEFORE.body, resultPreview: "result of k" },
      },
    });
    expect(finished.type !== "tool_started" && finished.durationMs).toEqual(
      expect.any(Number),
    );
  });

  it("forwards the application's descriptions, before and after", async () => {
    const describeToolCall = jest.fn(async () => described("Reading a.txt"));
    const describeToolResult = jest.fn(
      (request: {
        before: ToolDisplay;
        result: Readonly<ToolExecutionResult>;
      }) => ({
        ...request.before,
        body: { kind: "file_read" as const, path: "a.txt", lines: 3 },
      }),
    );
    const { run, toolEvents, execute } = setup({
      describeToolCall,
      describeToolResult,
    });
    await run();

    const [started, finished] = toolEvents();
    expect(started).toMatchObject({ display: described("Reading a.txt") });
    expect(finished).toMatchObject({
      type: "tool_finished",
      display: {
        title: "Reading a.txt",
        body: { kind: "file_read", path: "a.txt", lines: 3 },
      },
    });
    expect(describeToolCall).toHaveBeenCalledWith({
      name: "lookup",
      toolCallId: "call-1",
      args: { key: "k" },
      scope: { allowedTools: undefined },
    });
    // The call is described before it runs, and its result with that
    // description in hand.
    expect(describeToolCall.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0],
    );
    expect(describeToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "lookup",
        toolCallId: "call-1",
        before: described("Reading a.txt"),
        result: expect.objectContaining({ content: "result of k" }),
      }),
    );
  });

  it("marks a failed call's description and reports it as tool_failed", async () => {
    const { run, toolEvents } = setup({}, async () => ({
      status: "error",
      content: "no such record",
    }));
    await run();

    const failed = toolEvents()[1];
    expect(failed).toMatchObject({
      type: "tool_failed",
      display: { title: "lookup", error: "no such record" },
    });
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("cannot describe");
      },
    ],
    ["rejects", async () => Promise.reject(new Error("cannot describe"))],
    ["never settles", () => new Promise<ToolDisplay>(() => {})],
  ])(
    "runs the call with a generic description when describing it %s",
    async (_case, describeToolCall) => {
      const { run, toolEvents, execute } = setup({
        describeToolCall,
        describeToolResult: () => {
          throw new Error("cannot describe");
        },
      });
      const started = Date.now();
      expect(await run()).toBe("Done.");

      expect(Date.now() - started).toBeLessThan(2000);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(toolEvents()[0]).toMatchObject({ display: GENERIC_BEFORE });
      expect(toolEvents()[1]).toMatchObject({
        type: "tool_finished",
        display: { body: { kind: "generic", resultPreview: "result of k" } },
      });
    },
  );

  it("drops a description that fails after the budget has passed", async () => {
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { run, execute } = setup({
        describeToolCall: () =>
          new Promise<ToolDisplay>((_resolve, reject) => {
            setTimeout(() => reject(new Error("late")), 400);
          }),
      });
      expect(await run()).toBe("Done.");
      expect(execute).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("gives the hooks copies, so presentation cannot change what runs or is recorded", async () => {
    const { run, toolEvents, execute, requests } = setup(
      {
        describeToolCall: ({ args, scope }) => {
          expect(scope).toEqual({ allowedTools: undefined });
          (args.tags as string[]).sort();
          (args as Record<string, unknown>).key = "changed";
          return described("Reading a.txt");
        },
        describeToolResult: ({ result, before }) => {
          (result as ToolExecutionResult).content = "rewritten";
          (before as { title: string }).title = "rewritten";
          return before;
        },
      },
      undefined,
      { key: "k", tags: ["b", "a"] },
    );
    await run();

    expect(execute).toHaveBeenCalledWith(
      { key: "k", tags: ["b", "a"] },
      expect.anything(),
    );
    const [started, finished] = toolEvents();
    expect(started.display.title).toBe("Reading a.txt");
    expect(finished.display.title).toBe("rewritten");
    const toolMessage = requests[1].messages.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.toolResults?.[0]?.content).toBe("result of k");
  });

  it("passes the scope the call will be authorized against", async () => {
    const seen: unknown[] = [];
    const { run } = setup({
      describeToolCall: ({ scope }) => {
        seen.push(scope);
        return described("Reading a.txt");
      },
    });
    await run();
    expect(seen).toEqual([{ allowedTools: undefined }]);
  });

  it("emits payloads that are plain JSON", async () => {
    const { run, toolEvents } = setup();
    await run();
    for (const event of toolEvents()) {
      expect(JSON.parse(JSON.stringify(event.display))).toEqual(event.display);
    }
  });

  it("times the tool, not the wait for a decision about it", async () => {
    const { run, toolEvents } = setup(
      {
        authorizeTool: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { allowed: true, actor: "user", rule: "test" };
        },
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { status: "success", content: "ok" };
      },
    );
    await run();
    const finished = toolEvents()[1];
    const durationMs =
      finished.type === "tool_started" ? -1 : finished.durationMs;
    expect(durationMs).toBeGreaterThanOrEqual(30);
    expect(durationMs).toBeLessThan(250);
  });

  it("reports no run time for a call that was denied", async () => {
    const { run, toolEvents, execute } = setup({
      authorizeTool: () => ({
        allowed: false,
        actor: "user",
        rule: "test",
        reason: "Not that one",
      }),
    });
    await run();
    expect(execute).not.toHaveBeenCalled();
    expect(toolEvents()[1]).toMatchObject({
      type: "tool_failed",
      durationMs: 0,
      display: {
        title: "lookup",
        error: expect.stringContaining("Not that one"),
      },
    });
  });
});
