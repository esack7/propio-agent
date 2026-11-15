import {
  AgentSession,
  InMemorySessionEventLog,
  normalizeSessionEvent,
  parseProtocolEvent,
} from "../index.js";

const display = {
  title: "Calling server",
  body: { kind: "generic", fields: [], truncated: false },
} as const;
const started = {
  type: "tool_started",
  toolCallId: "t",
  toolName: "server",
  display,
  args: {},
  argumentChars: 2,
};

it("normalizes non-JSON arguments without touching the originals, counting replacements", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const args = {
    n: NaN,
    infinity: Infinity,
    big: 5n,
    absent: undefined,
    fn: () => 1,
    circular,
    date: new Date(),
    nested: [undefined],
  };
  const result = normalizeSessionEvent({ ...started, args });
  expect(result.replacedValues).toBe(8);
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  expect(args.big).toBe(5n);
  expect(circular.self).toBe(circular);
  expect(Object.isFrozen(result.event)).toBe(true);
  expect(
    normalizeSessionEvent({ type: "turn_failed", error: new TypeError("bad") })
      .event,
  ).toEqual({
    type: "turn_failed",
    error: { name: "TypeError", message: "bad" },
  });
});

it("reduces prompt plans to numeric metadata, omitting messages and identifiers", () => {
  const { event } = normalizeSessionEvent({
    type: "prompt_plan_built",
    snapshot: {
      provider: "local",
      model: "test",
      iteration: 1,
      contextWindowTokens: 1000,
      availableInputBudget: 900,
      plan: {
        messages: [{ content: "private" }],
        estimatedPromptTokens: 42,
        includedTurnIds: ["one"],
        omittedTurnIds: ["two", "three"],
        retryLevel: 0,
        usedRollingSummary: false,
      },
    },
  });
  expect(event).toMatchObject({
    snapshot: { includedTurns: 1, omittedTurns: 2, estimatedPromptTokens: 42 },
  });
  expect(JSON.stringify(event)).not.toMatch(/private|messages|TurnIds/);
});

it.each([
  null,
  {},
  { seq: 0, event: { type: "turn_started" } },
  { seq: 1.5, event: { type: "turn_started" } },
  { seq: Number.MAX_SAFE_INTEGER + 1, event: { type: "turn_started" } },
  { seq: 1, event: { type: "invented" } },
  { seq: 1, event: { type: "assistant_text", delta: 4 } },
  { seq: 1, event: { type: "turn_failed", error: new Error("bad") } },
  {
    seq: 1,
    event: { ...started, display: { ...display, body: { kind: "generic" } } },
  },
  { seq: 1, event: { ...started, args: { bad: Infinity } } },
  { seq: 1, event: { ...started, unexpected: true } },
  {
    seq: 1,
    event: { type: "approval_resolved", requestId: "a", resolution: "yes" },
  },
  {
    seq: 1,
    event: {
      type: "tool_output",
      toolCallId: "t",
      stream: "stdout",
      text: "x",
      droppedBytes: 0,
      elapsedMs: 1,
      transient: false,
    },
  },
])("rejects malformed protocol input %#", (value) => {
  expect(() => parseProtocolEvent(value)).toThrow();
});

it("rejects cycles, excessive depth and getters before schema recursion", () => {
  const value: Record<string, unknown> = {};
  value.self = value;
  expect(() =>
    parseProtocolEvent({ seq: 1, event: { type: "custom", value } }),
  ).toThrow(/circular/);
  const getter = jest.fn(() => 1);
  expect(() =>
    parseProtocolEvent({
      seq: 1,
      event: {
        type: "custom",
        value: Object.defineProperty({}, "x", {
          get: getter,
          enumerable: true,
        }),
      },
    }),
  ).toThrow(/accessor/);
  expect(getter).not.toHaveBeenCalled();
  let deep: unknown = null;
  for (let i = 0; i < 110; i++) deep = [deep];
  expect(() => parseProtocolEvent(deep)).toThrow(/depth/);
});

it("keeps a detached immutable log, with fresh cursor arrays", () => {
  const log = new InMemorySessionEventLog();
  const event = {
    seq: 12,
    event: { type: "assistant_text" as const, delta: "original" },
  };
  log.append(event);
  event.event.delta = "mutated";
  expect(log.after(0)[0].event).toEqual({
    type: "assistant_text",
    delta: "original",
  });
  expect(() => {
    (log.after(0)[0].event as { delta: string }).delta = "mutate";
  }).toThrow();
  expect(log.after(12)).toEqual([]);
  expect(() => log.append({ ...event, seq: 14 })).toThrow(/contiguous/);
  expect(() => log.after(-1)).toThrow();
});

it("numbers per session across turns and delivers reentrant dispatch in order", async () => {
  const log = new InMemorySessionEventLog();
  const session = new AgentSession({
    firstSequence: 40,
    eventLog: log,
    runTurn: async () => "done",
  });
  const seen: number[][] = [[], []];
  session.subscribeProtocol((event) => {
    seen[0].push(event.seq);
    if (event.event.type === "session_turn_started")
      session.dispatch({ type: "guide", commandId: "g", text: "follow up" });
  });
  session.subscribeProtocol((event) => seen[1].push(event.seq));
  for (const commandId of ["a", "b"]) {
    session.dispatch({ type: "submit", commandId, text: "hello" });
    await session.settled();
  }
  expect(seen).toEqual([
    [40, 41, 42, 43, 44, 45],
    [40, 41, 42, 43, 44, 45],
  ]);
  expect(log.after(42).map((event) => event.seq)).toEqual([43, 44, 45]);
  for (const event of log.after(0))
    expect(parseProtocolEvent(JSON.parse(JSON.stringify(event)))).toEqual(
      event,
    );
  const other = new AgentSession({ runTurn: async () => "done" });
  const otherEvents: number[] = [];
  other.subscribeProtocol((event) => otherEvents.push(event.seq));
  other.dispatch({ type: "submit", commandId: "x", text: "hello" });
  await other.settled();
  expect(otherEvents).toEqual([1, 2]);
});

it("does not let a throwing listener starve later observers or queued events", async () => {
  const session = new AgentSession({ runTurn: async () => "done" });
  session.subscribeProtocol(() => {
    throw new Error("observer failed");
  });
  const events: unknown[] = [];
  session.subscribeProtocol((event) => events.push(event));
  session.dispatch({ type: "submit", commandId: "x", text: "hello" });
  await session.settled();
  expect(events).toMatchObject([
    { seq: 1 },
    {
      seq: 2,
      event: { outcome: "failed", error: { message: "observer failed" } },
    },
  ]);
});

it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid sequence seed %s",
  (firstSequence) => {
    expect(
      () => new AgentSession({ firstSequence, runTurn: async () => "done" }),
    ).toThrow();
  },
);
