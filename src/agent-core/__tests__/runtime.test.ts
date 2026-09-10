import { describe, expect, it, jest } from "@jest/globals";
import {
  ProviderContextLengthError,
  type ChatRequest,
  type ChatStreamEvent,
  type LLMProvider,
} from "@propio-ai/providers";
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type AgentVisibilityEvent,
} from "../index.js";
import { ConversationManager } from "../../context/index.js";
import { ToolRegistry, createExecutableTool } from "../../tools/index.js";

const toolCall: ChatStreamEvent = {
  type: "tool_calls",
  toolCalls: [
    {
      id: "call-1",
      function: { name: "lookup", arguments: { key: "example" } },
    },
  ],
  reasoningContent: "opaque-continuation",
};
const answer: ChatStreamEvent = { type: "assistant_text", delta: "Finished." };
function setup(
  rounds: (ChatStreamEvent[] | Error)[],
  overrides: Partial<AgentRuntimeOptions> = {},
) {
  const requests: ChatRequest[] = [];
  const context = new ConversationManager();
  const provider: LLMProvider = {
    name: "test",
    getCapabilities: () => ({ contextWindowTokens: 32000 }),
    async *streamChat(request) {
      const round = rounds[requests.length] ?? [answer];
      requests.push(request);
      if (round instanceof Error) throw round;
      yield* round;
    },
  };
  const tools = new ToolRegistry();
  const execute = jest.fn(async () => "Found the record.");
  tools.register(
    createExecutableTool({
      schema: {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object" },
        },
      },
      invoke: async () => ({ status: "success", content: await execute() }),
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
      maxIterations: 5,
      useNoProgressDetector: true,
      streamIdleTimeoutMs: 0,
      outputTokenRecoveryLimit: 1,
    },
    ...overrides,
  });
  const events: AgentVisibilityEvent[] = [];
  const tokens: string[] = [];
  const run = (signal?: AbortSignal) =>
    runtime.streamChat(
      { text: "Find the record" },
      (token) => tokens.push(token),
      { onEvent: (event) => events.push(event), abortSignal: signal },
    );
  return { runtime, run, events, tokens, execute, requests, context };
}

describe("public headless runtime", () => {
  it("orders lifecycle and tool events and replays opaque continuation through the public context", async () => {
    const fixture = setup([
      [{ type: "thinking_delta", delta: "Looking" }, toolCall],
      [answer],
    ]);
    expect(await fixture.run()).toBe("Finished.");
    expect(
      fixture.events
        .filter((event) =>
          [
            "turn_started",
            "thinking_delta",
            "tool_started",
            "tool_finished",
            "turn_completed",
          ].includes(event.type),
        )
        .map((event) => event.type),
    ).toEqual([
      "turn_started",
      "thinking_delta",
      "tool_started",
      "tool_finished",
      "turn_completed",
    ]);
    expect(fixture.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          reasoningContent: "opaque-continuation",
        }),
        expect.objectContaining({ role: "tool" }),
      ]),
    );
    expect(fixture.tokens.join("")).toContain("Finished.");
  });

  it("keeps execution failures as tool results and continues to an answer", async () => {
    const fixture = setup([[toolCall], [answer]]);
    fixture.execute.mockRejectedValue(new Error("Lookup unavailable"));
    await expect(fixture.run()).resolves.toBe("Finished.");
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        type: "tool_failed",
        result: expect.stringContaining("Lookup unavailable"),
      }),
    );
    expect(
      fixture.requests[1].messages.some((message) =>
        JSON.stringify(message).includes("Lookup unavailable"),
      ),
    ).toBe(true);
  });

  it("enforces the execution allowlist even when the provider requests a hidden tool", async () => {
    const fixture = setup([[toolCall], [answer]], {
      policy: {
        maxIterations: 5,
        useNoProgressDetector: true,
        streamIdleTimeoutMs: 0,
        outputTokenRecoveryLimit: 0,
        allowedTools: () => new Set(),
      },
    });
    await fixture.run();
    expect(fixture.requests[0].tools).toEqual([]);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.events).toContainEqual(
      expect.objectContaining({ type: "tool_failed", status: "tool_disabled" }),
    );
  });

  it("retries context pressure with bounded prompt reduction", async () => {
    const pressure = new ProviderContextLengthError("Too long", "test");
    const fixture = setup([pressure, pressure, [answer]]);
    await fixture.run();
    const retries = fixture.events.flatMap((event) =>
      event.type === "prompt_plan_built"
        ? [event.snapshot.plan.retryLevel]
        : [],
    );
    expect(retries).toEqual([0, 1, 2]);
    expect(fixture.requests).toHaveLength(3);
  });

  it("stops after exhausting context recovery and preserves the provider error", async () => {
    const pressure = new ProviderContextLengthError("Too long", "test");
    const fixture = setup([pressure, pressure, pressure, pressure]);
    await expect(fixture.run()).rejects.toBe(pressure);
    expect(fixture.requests).toHaveLength(4);
    expect(fixture.events.at(-1)).toEqual({
      type: "turn_failed",
      error: pressure,
    });
  });

  it("recovers a max-token response using the same loop", async () => {
    const fixture = setup([
      [
        { type: "assistant_text", delta: "First. " },
        { type: "terminal", stopReason: "max_tokens" },
      ],
      [answer, { type: "terminal", stopReason: "end_turn" }],
    ]);
    await expect(fixture.run()).resolves.toBe("First. Finished.");
    expect(fixture.requests[1].messages).toContainEqual({
      role: "assistant",
      content: "First. ",
    });
  });

  it("does not mutate context for pre-cancelled input", async () => {
    const fixture = setup([[answer]]);
    const controller = new AbortController();
    controller.abort();
    await expect(fixture.run(controller.signal)).rejects.toThrow("cancelled");
    expect(fixture.context.getConversationState().turns).toHaveLength(0);
    expect(fixture.events).toEqual([]);
  });

  it("cancels a pending tool, ignores its late result, and accepts the next turn", async () => {
    const fixture = setup([[toolCall], [answer]]);
    const controller = new AbortController();
    let finish!: (result: string) => void;
    fixture.execute.mockImplementationOnce(async () => {
      controller.abort("escape");
      return await new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    await expect(fixture.run(controller.signal)).rejects.toThrow("cancelled");
    finish("late");
    await expect(fixture.run()).resolves.toBe("Finished.");
    expect(
      fixture.events.filter((event) => event.type === "tool_finished"),
    ).toEqual([]);
    expect(
      JSON.stringify(fixture.context.getConversationState()),
    ).not.toContain("late");
    expect(fixture.events).toContainEqual({ type: "turn_cancelled" });
  });

  it("never starts a tool when its start event cancels the turn", async () => {
    const fixture = setup([[toolCall]]);
    const controller = new AbortController();
    await expect(
      fixture.runtime.streamChat({ text: "Stop" }, () => {}, {
        abortSignal: controller.signal,
        onEvent: (event) => {
          if (event.type === "tool_started") controller.abort();
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("rejects overlapping turns before they mutate context", async () => {
    let release!: () => void;
    const fixture = setup([[answer]], {
      integrations: {
        prepareTurn: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      },
    });
    const first = fixture.run();
    await expect(fixture.run()).rejects.toThrow("already running");
    release();
    await first;
    expect(fixture.context.getConversationState().turns).toHaveLength(1);
  });

  it.each(["cancel", "timeout"])(
    "returns promptly from a stalled stream on %s",
    async (mode) => {
      const controller = new AbortController();
      const close = jest.fn(
        async () => new Promise<IteratorResult<ChatStreamEvent>>(() => {}),
      );
      const provider: LLMProvider = {
        name: "stalled",
        getCapabilities: () => ({ contextWindowTokens: 32000 }),
        streamChat: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (mode === "cancel") queueMicrotask(() => controller.abort());
              return await new Promise<IteratorResult<ChatStreamEvent>>(
                () => {},
              );
            },
            return: close,
          }),
        }),
      };
      const fixture = setup([], {
        provider,
        policy: {
          maxIterations: 2,
          useNoProgressDetector: true,
          streamIdleTimeoutMs: 10,
          outputTokenRecoveryLimit: 0,
        },
      });
      await expect(fixture.run(controller.signal)).rejects.toThrow(
        mode === "cancel" ? "cancelled" : "idle timeout",
      );
      expect(close).toHaveBeenCalledTimes(1);
    },
  );
});

async function withDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Turn did not settle")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function callbackFailureProvider(
  close: () => Promise<IteratorResult<ChatStreamEvent>>,
): LLMProvider {
  let firstRequest = true;
  return {
    name: "consumer-failure",
    getCapabilities: () => ({ contextWindowTokens: 32000 }),
    streamChat() {
      if (!firstRequest)
        return (async function* () {
          yield answer;
        })();
      firstRequest = false;
      let firstEvent = true;
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (firstEvent) {
              firstEvent = false;
              return { done: false, value: answer };
            }
            return await new Promise<IteratorResult<ChatStreamEvent>>(() => {});
          },
          return: close,
        }),
      };
    },
  };
}

describe("runtime integration boundaries", () => {
  it.each(["onToken", "onEvent"])(
    "fails promptly and remains reusable when %s throws with stalled iterator cleanup",
    async (callback) => {
      const close = jest.fn(
        async () =>
          await new Promise<IteratorResult<ChatStreamEvent>>(() => {}),
      );
      const failTurn = jest.fn(async () => {});
      const fixture = setup([], {
        provider: callbackFailureProvider(close),
        integrations: { failTurn },
      });
      const error = new Error("Consumer blew up");
      const events: AgentVisibilityEvent[] = [];
      await expect(
        withDeadline(
          fixture.runtime.streamChat(
            { text: "Fail" },
            () => {
              if (callback === "onToken") throw error;
            },
            {
              onEvent: (event) => {
                events.push(event);
                if (callback === "onEvent" && event.type === "assistant_text")
                  throw error;
              },
            },
          ),
        ),
      ).rejects.toBe(error);
      expect(close).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toEqual({ type: "turn_failed", error });
      expect(failTurn).toHaveBeenCalledWith(error);
      await expect(withDeadline(fixture.run())).resolves.toBe("Finished.");
    },
  );

  it("does not replace a consumer exception when iterator return throws synchronously", async () => {
    const close = () => {
      throw new Error("Close failed");
    };
    const fixture = setup([], { provider: callbackFailureProvider(close) });
    const error = new Error("Consumer failed");
    await expect(
      withDeadline(
        fixture.runtime.streamChat({ text: "Fail" }, () => {
          throw error;
        }),
      ),
    ).rejects.toBe(error);
    await expect(fixture.run()).resolves.toBe("Finished.");
  });

  it.each([true, false])(
    "honors an instruction adapter returning undefined (adapter present: %s)",
    async (present) => {
      const fixture = setup([[answer]], {
        integrations: present ? { instructions: () => undefined } : undefined,
      });
      const build = jest.spyOn(fixture.context, "buildPromptPlan");
      await fixture.runtime.streamChat({ text: "Hello" }, () => {}, {
        extraUserInstruction: "   ",
      });
      expect(build.mock.calls[0][1]).toBe(present ? undefined : "   ");
    },
  );

  it("does not clean up an earlier turn when input preparation fails", async () => {
    const prepareTurn = jest.fn(async () => {});
    const startTurn = jest.fn(async () => {});
    const completeTurn = jest.fn(async () => {});
    const failTurn = jest.fn(async () => {});
    const fixture = setup([[answer]], {
      integrations: { prepareTurn, startTurn, completeTurn, failTurn },
    });
    await fixture.run();
    const error = new Error("Preparation failed");
    prepareTurn.mockRejectedValueOnce(error);
    await expect(fixture.run()).rejects.toBe(error);
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(completeTurn).toHaveBeenCalledTimes(1);
    expect(failTurn).not.toHaveBeenCalled();
  });

  it("cleans up partially failed startup even if the failure event callback throws", async () => {
    const startupError = new Error("Startup partially failed");
    const callbackError = new Error("Failure observer failed");
    const failTurn = jest.fn(async () => {});
    const fixture = setup([], {
      integrations: {
        startTurn: () => {
          throw startupError;
        },
        failTurn,
      },
    });
    await expect(
      fixture.runtime.streamChat({ text: "Hello" }, () => {}, {
        onEvent: (event) => {
          if (event.type === "turn_failed") throw callbackError;
        },
      }),
    ).rejects.toBe(callbackError);
    expect(failTurn).toHaveBeenCalledWith(startupError);
  });

  it("does not clone prompt-plan snapshots without an event consumer", async () => {
    const fixture = setup([[answer]], {
      tools: {
        getEnabledSchemas: () => [],
        executeWithStatus: async () => ({
          status: "error",
          content: "Not used",
        }),
      },
    });
    const clone = jest.spyOn(globalThis, "structuredClone");
    try {
      await fixture.runtime.streamChat({ text: "Hello" }, () => {});
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });

  it("converts exceptions from a caller-owned executor to failed tool results", async () => {
    const fixture = setup([[toolCall], [answer]], {
      tools: {
        getEnabledSchemas: () => [],
        executeWithStatus: async () => {
          throw new Error("Executor crashed");
        },
      },
    });
    await expect(fixture.run()).resolves.toBe("Finished.");
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        type: "tool_failed",
        result: "Executor crashed",
      }),
    );
  });
});
