import type { ChatChunk, ChatRequest, LLMProvider } from "@propio-ai/providers";
import type { GuidanceMessage, GuidanceSource } from "../agent-core/index.js";
import { formatOperatorGuidance } from "../agent-core/runtime.js";
import {
  createMockTool,
  createTestAgent,
  userSubmission,
} from "./testHelpers.js";

/** Calls `lookup` once per listed batch, then answers. */
function scriptedProvider(
  batches: string[][],
): LLMProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: "scripted",
    requests,
    getCapabilities: () => ({ contextWindowTokens: 128000 }),
    async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
      const batch = batches[requests.length];
      requests.push(request);
      if (!batch) {
        yield { delta: `Answer ${requests.length}.` };
        return;
      }
      yield {
        delta: "",
        toolCalls: batch.map((id) => ({
          id,
          function: { name: "lookup", arguments: {} },
        })),
      };
    },
  };
}

function queue(): GuidanceSource & { push(id: string, text: string): void } {
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
  };
}

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

const userTexts = (request: ChatRequest) =>
  request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content);

describe("steering through the agent", () => {
  it("delivers guidance mid-turn and keeps it across a saved session (a1)", async () => {
    const provider = scriptedProvider([["call-1"]]);
    const guidance = queue();
    const agent = createTestAgent(provider);
    agent.addTool(
      createMockTool({
        name: "lookup",
        execute: async () => {
          guidance.push("g1", "Only the 2024 records.");
          return "found";
        },
      }),
    );
    const delivered: unknown[] = [];

    await agent.streamChat(userSubmission("Find the records"), () => {}, {
      guidance,
      onEvent: (event) => {
        if (event.type === "guidance_delivered") delivered.push(event);
      },
    });

    expect(delivered).toEqual([
      {
        type: "guidance_delivered",
        id: "g1",
        text: "Only the 2024 records.",
        iteration: 2,
      },
    ]);
    expect(userTexts(provider.requests[1]!)).toEqual([
      "Find the records",
      formatOperatorGuidance("Only the 2024 records."),
    ]);
    expectWellFormed(provider.requests[1]!);

    // A session saved after guidance loads in a fresh agent as it was.
    const resumedProvider = scriptedProvider([]);
    const resumed = createTestAgent(resumedProvider);
    resumed.importSession(agent.exportSession());
    await resumed.streamChat(userSubmission("And 2023?"), () => {});

    expect(userTexts(resumedProvider.requests[0]!)).toEqual([
      "Find the records",
      formatOperatorGuidance("Only the 2024 records."),
      "And 2023?",
    ]);
    expectWellFormed(resumedProvider.requests[0]!);
  });

  it("keeps completed work after an interrupt, in this session and a saved one (a2)", async () => {
    const provider = scriptedProvider([["call-1", "call-2", "call-3"]]);
    const controller = new AbortController();
    const executed: number[] = [];
    const agent = createTestAgent(provider);
    agent.addTool(
      createMockTool({
        name: "lookup",
        execute: async () => {
          executed.push(executed.length + 1);
          if (executed.length === 1) return "first result";
          controller.abort("interrupt");
          return await new Promise<string>(() => {});
        },
      }),
    );

    await expect(
      agent.streamChat(userSubmission("Find the records"), () => {}, {
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
    const saved = agent.exportSession();

    const check = (request: ChatRequest) => {
      expectWellFormed(request);
      const results = request.messages.flatMap(
        (message) => message.toolResults ?? [],
      );
      expect(results.map((result) => result.content)).toEqual([
        "first result",
        expect.stringMatching(/^\[Interrupted before this call finished/),
        expect.stringMatching(/^\[Not run: the turn was interrupted/),
      ]);
      expect(userTexts(request)).toEqual(["Find the records", "Go on"]);
    };

    await agent.streamChat(userSubmission("Go on"), () => {});
    check(provider.requests[1]!);

    const resumedProvider = scriptedProvider([]);
    const resumed = createTestAgent(resumedProvider);
    resumed.addTool(
      createMockTool({
        name: "lookup",
        execute: async () => {
          executed.push(-1);
          return "replayed";
        },
      }),
    );
    resumed.importSession(saved);
    await resumed.streamChat(userSubmission("Go on"), () => {});
    check(resumedProvider.requests[0]!);

    // Two calls started; the third never did, and nothing ran again.
    expect(executed).toEqual([1, 2]);
  });
});
