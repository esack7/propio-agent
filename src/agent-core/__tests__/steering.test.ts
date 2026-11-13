import { describe, expect, it, jest } from "@jest/globals";
import type {
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  LLMProvider,
} from "@propio-ai/providers";
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type AgentVisibilityEvent,
  type GuidanceMessage,
  type GuidanceSource,
} from "../index.js";
import { formatOperatorGuidance } from "../runtime.js";
import { ConversationManager } from "../../context/index.js";
import { ToolRegistry, createExecutableTool } from "../../tools/index.js";
import type { TraceEventInput } from "../../trace/index.js";

const calls = (...ids: string[]): ChatStreamEvent => ({
  type: "tool_calls",
  toolCalls: ids.map((id) => ({
    id,
    function: { name: "lookup", arguments: { key: id } },
  })),
});
const text = (delta: string): ChatStreamEvent => ({
  type: "assistant_text",
  delta,
});

type Round = ChatStreamEvent[] | (() => ChatStreamEvent[]);

function createQueue(): GuidanceSource & {
  push(id: string, text: string): void;
  readonly waiting: readonly GuidanceMessage[];
} {
  let waiting: GuidanceMessage[] = [];
  return {
    push: (id, text) => {
      waiting.push({ id, text });
    },
    drain: () => {
      const taken = waiting;
      waiting = [];
      return taken;
    },
    get waiting() {
      return waiting;
    },
  };
}

function setup(rounds: Round[], overrides: Partial<AgentRuntimeOptions> = {}) {
  const requests: ChatRequest[] = [];
  const context = new ConversationManager();
  const provider: LLMProvider = {
    name: "test",
    getCapabilities: () => ({ contextWindowTokens: 32000 }),
    async *streamChat(request) {
      const round = rounds[requests.length] ?? [text("Finished.")];
      requests.push(request);
      yield* typeof round === "function" ? round() : round;
    },
  };
  const tools = new ToolRegistry();
  const execute = jest.fn(async (key: string) => `result of ${key}`);
  tools.register(
    createExecutableTool({
      schema: {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: {
            type: "object",
            properties: { key: { type: "string" } },
          },
        },
      },
      invoke: async (args) => ({
        status: "success",
        content: await execute(String(args.key)),
      }),
    }),
    true,
  );
  const runtime = new AgentRuntime({
    provider,
    model: "example",
    context,
    tools,
    systemPrompt: "Answer questions about records.",
    policy: {
      maxIterations: 6,
      useNoProgressDetector: false,
      streamIdleTimeoutMs: 0,
      outputTokenRecoveryLimit: 1,
    },
    ...overrides,
  });
  const events: AgentVisibilityEvent[] = [];
  const queue = createQueue();
  const run = (signal?: AbortSignal, prompt = "Find the records") =>
    runtime.streamChat({ text: prompt }, () => {}, {
      onEvent: (event) => events.push(event),
      abortSignal: signal,
      guidance: queue,
    });
  return { runtime, run, events, execute, requests, context, queue };
}

/** The request's conversation, without the system prompt. */
const conversation = (request: ChatRequest): ChatMessage[] =>
  request.messages.filter((message) => message.role !== "system");

const guidance = (value: string) => ({
  role: "user",
  content: formatOperatorGuidance(value),
});

/** Every tool call the model made has exactly one result. */
function expectWellFormed(request: ChatRequest): void {
  const called = request.messages.flatMap((message) =>
    (message.toolCalls ?? []).map((call) => call.id),
  );
  const answered = request.messages.flatMap((message) =>
    (message.toolResults ?? []).map((result) => result.toolCallId),
  );
  expect([...answered].sort()).toEqual([...called].sort());
  expect(new Set(answered).size).toBe(answered.length);
}

const resultOf = (request: ChatRequest, toolCallId: string) =>
  request.messages
    .flatMap((message) => message.toolResults ?? [])
    .find((result) => result.toolCallId === toolCallId)?.content;

describe("operator guidance (a1)", () => {
  it("reaches the model before its next request, in the order submitted", async () => {
    const fixture = setup([[calls("a")], [calls("b")], [text("Done.")]]);
    fixture.execute.mockImplementation(async (key) => {
      if (key === "a") {
        fixture.queue.push("g1", "Only look at 2024.");
        fixture.queue.push("g2", "Skip archived records.");
      } else {
        fixture.queue.push("g3", "Report totals only.");
      }
      return `result of ${key}`;
    });

    await expect(fixture.run()).resolves.toBe("Done.");

    expect(fixture.requests).toHaveLength(3);
    // Nothing was waiting before the first request.
    expect(conversation(fixture.requests[0]!)).toHaveLength(1);
    // Both messages sent during the first call follow its result, in order.
    expect(conversation(fixture.requests[1]!).slice(-3)).toMatchObject([
      { role: "tool" },
      guidance("Only look at 2024."),
      guidance("Skip archived records."),
    ]);
    // The third follows the second call's result and the earlier two stay put.
    const last = conversation(fixture.requests[2]!);
    expect(last.slice(-1)).toMatchObject([guidance("Report totals only.")]);
    const order = last
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    expect(order).toEqual([
      "Find the records",
      formatOperatorGuidance("Only look at 2024."),
      formatOperatorGuidance("Skip archived records."),
      formatOperatorGuidance("Report totals only."),
    ]);
    for (const request of fixture.requests) expectWellFormed(request);

    expect(
      fixture.events.filter((event) => event.type === "guidance_delivered"),
    ).toEqual([
      {
        type: "guidance_delivered",
        id: "g1",
        text: "Only look at 2024.",
        iteration: 2,
      },
      {
        type: "guidance_delivered",
        id: "g2",
        text: "Skip archived records.",
        iteration: 2,
      },
      {
        type: "guidance_delivered",
        id: "g3",
        text: "Report totals only.",
        iteration: 3,
      },
    ]);
    expect(fixture.queue.waiting).toEqual([]);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
  });

  it("continues the turn when guidance arrives during the final answer", async () => {
    const fixture = setup([
      () => {
        fixture.queue.push("g1", "Also list the owners.");
        return [text("Here are the records.")];
      },
      [text("Here are the records and their owners.")],
    ]);

    await expect(fixture.run()).resolves.toBe(
      "Here are the records and their owners.",
    );

    expect(fixture.requests).toHaveLength(2);
    expect(conversation(fixture.requests[1]!).slice(-2)).toMatchObject([
      { role: "assistant", content: "Here are the records." },
      guidance("Also list the owners."),
    ]);
    expect(
      fixture.events.filter((event) => event.type === "turn_completed"),
    ).toHaveLength(1);
  });

  it("ends the turn at the final answer when nothing is waiting", async () => {
    const fixture = setup([[text("Here are the records.")]]);
    await expect(fixture.run()).resolves.toBe("Here are the records.");
    expect(fixture.requests).toHaveLength(1);
    expect(
      fixture.events.some((event) => event.type === "guidance_delivered"),
    ).toBe(false);
  });

  it("delivers guidance that is already waiting before the first request", async () => {
    const fixture = setup([[text("Done.")]]);
    fixture.queue.push("g1", "Be brief.");
    await fixture.run();
    expect(conversation(fixture.requests[0]!)).toMatchObject([
      { role: "user", content: "Find the records" },
      guidance("Be brief."),
    ]);
  });

  it("leaves guidance in the queue when the iteration limit ends the turn", async () => {
    const fixture = setup(
      [
        () => {
          fixture.queue.push("g1", "One more thing.");
          return [text("Done.")];
        },
      ],
      {
        policy: {
          maxIterations: 1,
          useNoProgressDetector: false,
          streamIdleTimeoutMs: 0,
          outputTokenRecoveryLimit: 1,
        },
      },
    );
    await expect(fixture.run()).resolves.toBe("Done.");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.queue.waiting).toEqual([
      { id: "g1", text: "One more thing." },
    ]);
  });
});

describe("interrupting a turn (a2)", () => {
  it("keeps completed results, resolves the rest, and replays nothing", async () => {
    const fixture = setup([[calls("a", "b", "c")], [text("Carrying on.")]]);
    const controller = new AbortController();
    let finishLate!: (value: string) => void;
    fixture.execute.mockImplementation(async (key) => {
      if (key !== "b") return `result of ${key}`;
      controller.abort("interrupt");
      return await new Promise<string>((resolve) => {
        finishLate = resolve;
      });
    });

    await expect(fixture.run(controller.signal)).rejects.toThrow("cancelled");
    finishLate("late result of b");

    expect(fixture.events.at(-1)).toEqual({
      type: "turn_cancelled",
      phase: "tool",
      interruptedToolCallIds: ["b", "c"],
    });
    // "c" never started.
    expect(fixture.execute.mock.calls.map(([key]) => key)).toEqual(["a", "b"]);

    await expect(fixture.run(undefined, "What happened?")).resolves.toBe(
      "Carrying on.",
    );

    const next = fixture.requests[1]!;
    expectWellFormed(next);
    expect(resultOf(next, "a")).toBe("result of a");
    expect(resultOf(next, "b")).toMatch(
      /^\[Interrupted before this call finished/,
    );
    expect(resultOf(next, "c")).toMatch(/^\[Not run: the turn was interrupted/);
    expect(JSON.stringify(next.messages)).not.toContain("late result of b");
    expect(conversation(next).at(-1)).toMatchObject({
      role: "user",
      content: "What happened?",
    });
    // The interrupted turn's work is in context and nothing ran again.
    expect(fixture.execute).toHaveBeenCalledTimes(2);
  });

  it("resolves a call interrupted while it awaited approval, without running it", async () => {
    const controller = new AbortController();
    const fixture = setup([[calls("a", "b")], [text("Carrying on.")]], {
      integrations: {
        authorizeTool: (request) =>
          new Promise((_resolve, reject) => {
            controller.abort("interrupt");
            request.signal?.addEventListener("abort", () =>
              reject(new Error("withdrawn")),
            );
            if (request.signal?.aborted) reject(new Error("withdrawn"));
          }),
      },
    });

    await expect(fixture.run(controller.signal)).rejects.toThrow("cancelled");
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.events.at(-1)).toMatchObject({
      type: "turn_cancelled",
      phase: "tool",
      interruptedToolCallIds: ["a", "b"],
    });

    await fixture.run(undefined, "Continue");
    expectWellFormed(fixture.requests[1]!);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("keeps a finished batch when the next model step is interrupted", async () => {
    const controller = new AbortController();
    const fixture = setup([
      [calls("a")],
      () => {
        controller.abort("interrupt");
        return [text("Half an ans")];
      },
      [text("Carrying on.")],
    ]);

    await expect(fixture.run(controller.signal)).rejects.toThrow("cancelled");
    expect(fixture.events.at(-1)).toEqual({
      type: "turn_cancelled",
      phase: "model",
    });

    await fixture.run(undefined, "Continue");
    const next = fixture.requests[2]!;
    expectWellFormed(next);
    expect(resultOf(next, "a")).toBe("result of a");
    // The unfinished step is not in context.
    expect(JSON.stringify(next.messages)).not.toContain("Half an ans");
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it("removes a turn interrupted before the model produced anything", async () => {
    const controller = new AbortController();
    const fixture = setup([
      () => {
        controller.abort("interrupt");
        return [text("Never finished")];
      },
    ]);
    await expect(fixture.run(controller.signal)).rejects.toThrow("cancelled");
    expect(fixture.context.getConversationState().turns).toHaveLength(0);
  });

  it("leaves guidance that was not delivered in the queue", async () => {
    const controller = new AbortController();
    const fixture = setup([[calls("a")]]);
    fixture.execute.mockImplementation(async () => {
      fixture.queue.push("g1", "Too late.");
      controller.abort("interrupt");
      return await new Promise<string>(() => {});
    });
    await expect(fixture.run(controller.signal)).rejects.toThrow("cancelled");
    expect(fixture.queue.waiting).toEqual([{ id: "g1", text: "Too late." }]);
    expect(
      JSON.stringify(fixture.context.getConversationState()),
    ).not.toContain("Too late.");
  });
});

describe("steering in the trace (a8)", () => {
  const recorder = (captureLevel?: "standard" | "full") => {
    const records: TraceEventInput[] = [];
    return {
      records,
      trace: {
        identity: { sessionId: "session-1", runId: "run-1" },
        captureLevel,
        record: (event: TraceEventInput) => records.push(event),
        captureMaterial: (value: unknown) => ({
          path: "material/1",
          sha256: "0".repeat(64),
          sizeBytes: JSON.stringify(value).length,
          encoding: "json" as const,
        }),
      },
    };
  };

  it("records each delivered guidance message with actor user", async () => {
    const { records, trace } = recorder();
    const fixture = setup([[calls("a")], [text("Done.")]], { trace });
    fixture.execute.mockImplementation(async () => {
      fixture.queue.push("g1", "Only 2024.");
      fixture.queue.push("g2", "Totals only.");
      return "ok";
    });
    await fixture.run();

    const guidanceRecords = records.filter(
      (record) => record.type === "operator_guidance",
    );
    expect(guidanceRecords.map((record) => record.payload)).toEqual([
      { actor: "user", guidanceId: "g1", iteration: 2, textChars: 10 },
      { actor: "user", guidanceId: "g2", iteration: 2, textChars: 12 },
    ]);
    // The text itself is not in a standard trace.
    expect(JSON.stringify(guidanceRecords)).not.toContain("Only 2024.");
    // Each is recorded before the request it precedes.
    const types = records.map((record) => record.type);
    expect(types.lastIndexOf("operator_guidance")).toBeLessThan(
      types.lastIndexOf("provider_request_dispatched"),
    );
    expect(guidanceRecords[0]!.identity?.turnId).toEqual(expect.any(String));
  });

  it("captures the guidance text only at full capture", async () => {
    const { records, trace } = recorder("full");
    const fixture = setup([[calls("a")], [text("Done.")]], { trace });
    fixture.execute.mockImplementation(async () => {
      fixture.queue.push("g1", "Only 2024.");
      return "ok";
    });
    await fixture.run();
    expect(
      records.find((record) => record.type === "operator_guidance")?.payload,
    ).toMatchObject({ text: { path: "material/1", encoding: "json" } });
  });

  it.each([
    ["interrupt", "user"],
    ["escape", "user"],
    ["sigint", "user"],
    ["shutdown", "application"],
  ])("records a turn stopped by %s with actor %s", async (reason, actor) => {
    const { records, trace } = recorder();
    const controller = new AbortController();
    const fixture = setup([[calls("a", "b")]], { trace });
    fixture.execute.mockImplementation(async () => {
      controller.abort(reason);
      return await new Promise<string>(() => {});
    });
    await expect(fixture.run(controller.signal)).rejects.toThrow("cancelled");

    expect(
      records.find((record) => record.type === "turn_cancelled")?.payload,
    ).toEqual({
      actor,
      reason,
      phase: "tool",
      interruptedToolCallIds: ["a", "b"],
    });
  });
});
