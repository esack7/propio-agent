import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  ChatRequest,
  ChatStreamEvent,
  LLMProvider,
} from "@propio-ai/providers";
import {
  AgentRuntime,
  AgentSession,
  encodeCommandImage,
  parseSessionCommand,
  type AgentVisibilityEvent,
  type CommandResult,
  type SessionCommand,
  type SessionEvent,
} from "../index.js";
import { formatOperatorGuidance } from "../runtime.js";
import { ConversationManager } from "../../context/index.js";
import { InMemoryPermissionStore, PolicyEngine } from "../../policy/index.js";
import { ToolRegistry, createExecutableTool } from "../../tools/index.js";

type Event = SessionEvent<AgentVisibilityEvent>;

const call = (id: string, name: string, key: string): ChatStreamEvent => ({
  type: "tool_calls",
  toolCalls: [{ id, function: { name, arguments: { key } } }],
});
const text = (delta: string): ChatStreamEvent => ({
  type: "assistant_text",
  delta,
});

/**
 * A session over the real runtime: a scripted provider, a `lookup` tool that
 * runs freely, and a `risky` tool that the policy engine asks about. Nothing
 * here reads input; the turn is driven only by what is dispatched.
 */
async function createHeadlessSession(
  rounds: ChatStreamEvent[][],
  /** Holds the first lookup open, for a sender that replies asynchronously. */
  firstLookup: Promise<void> = Promise.resolve(),
) {
  const requests: ChatRequest[] = [];
  const executed: string[] = [];
  const provider: LLMProvider = {
    name: "test",
    getCapabilities: () => ({ contextWindowTokens: 32000 }),
    async *streamChat(request) {
      const round = rounds[requests.length] ?? [text("Finished.")];
      requests.push(request);
      yield* round;
    },
  };
  const tools = new ToolRegistry();
  for (const name of ["lookup", "risky"]) {
    tools.register(
      createExecutableTool({
        schema: {
          type: "function",
          function: {
            name,
            description: name,
            parameters: {
              type: "object",
              properties: { key: { type: "string" } },
            },
          },
        },
        invoke: async (args, context) => {
          executed.push(`${name}:${String(args.key)}`);
          if (args.key === "a") await firstLookup;
          if (args.key === "b") {
            // Runs until the turn is interrupted.
            await new Promise((_resolve, reject) =>
              context?.signal?.addEventListener("abort", () =>
                reject(new Error("aborted")),
              ),
            );
          }
          return {
            status: "success",
            content: `result of ${String(args.key)}`,
          };
        },
      }),
      true,
    );
  }
  const policy = await PolicyEngine.create({
    store: new InMemoryPermissionStore({}),
    owner: "test",
    workspaceRoot: "/work",
  });
  const runtime = new AgentRuntime({
    provider,
    model: "example",
    context: new ConversationManager(),
    tools,
    systemPrompt: "Answer questions about records.",
    policy: {
      maxIterations: 8,
      useNoProgressDetector: false,
      streamIdleTimeoutMs: 0,
      outputTokenRecoveryLimit: 1,
    },
    integrations: {
      authorizeTool: async (request) => {
        if (request.name !== "risky")
          return { allowed: true, actor: "application", rule: "fixture" };
        const evaluation = policy.evaluate({
          toolName: request.name,
          args: request.args as never,
          metadata: {
            capabilities: ["external"],
            readOnly: false,
            concurrencySafe: false,
          },
        });
        if (evaluation.outcome !== "ask") throw new Error("expected an ask");
        const answer = await session.approvalChannel.request(
          evaluation.request,
          request.signal,
        );
        const decision = await policy.answer(answer);
        return {
          allowed: decision.outcome === "allow",
          actor: decision.actor,
          rule: decision.rule,
          reason: decision.reason,
        };
      },
    },
  });
  const session: AgentSession<AgentVisibilityEvent> = new AgentSession({
    runTurn: (submission, control) =>
      runtime.streamChat(submission, () => {}, {
        abortSignal: control.abortSignal,
        guidance: control.guidance,
        onEvent: control.emit,
      }),
  });
  const events: Event[] = [];
  session.subscribe((event) => events.push(event));
  return { session, events, requests, executed };
}

/** Send a command the way a transport would: as JSON text, parsed on arrival. */
function sendJson(
  session: AgentSession<AgentVisibilityEvent>,
  command: SessionCommand,
): CommandResult {
  const wire = JSON.stringify(command);
  const parsed = parseSessionCommand(JSON.parse(wire));
  if (!parsed.ok) throw new Error(parsed.message);
  expect(parsed.command).toEqual(command);
  return session.dispatch(parsed.command);
}

const userMessages = (request: ChatRequest) =>
  request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content);
const toolResults = (request: ChatRequest) =>
  Object.fromEntries(
    request.messages
      .flatMap((message) => message.toolResults ?? [])
      .map((result) => [result.toolCallId, result.content]),
  );

/** What the steered conversation must look like, however it was driven. */
function expectSteeredConversation(
  requests: ChatRequest[],
  executed: string[],
  denial: RegExp,
): void {
  expect(requests).toHaveLength(4);
  // The guidance reached the model before its second request.
  expect(userMessages(requests[1]!)).toEqual([
    "Find the records",
    formatOperatorGuidance("Only the 2024 records."),
  ]);
  // The denial and its reason came back as the tool's result, and the turn
  // went on to a third request.
  expect(toolResults(requests[2]!)["call-2"]).toMatch(denial);
  // After the interrupt, the next submit continues from completed work.
  const last = requests[3]!;
  expect(userMessages(last)).toEqual([
    "Find the records",
    formatOperatorGuidance("Only the 2024 records."),
    "Carry on",
  ]);
  const results = toolResults(last);
  expect(results["call-1"]).toBe("result of a");
  expect(results["call-2"]).toMatch(denial);
  expect(results["call-3"]).toMatch(/^\[Interrupted before this call finished/);
  const called = last.messages.flatMap((message) =>
    (message.toolCalls ?? []).map((toolCall) => toolCall.id),
  );
  expect(Object.keys(results).sort()).toEqual([...called].sort());
  // The denied tool never ran and nothing ran twice. The interrupted lookup
  // ran at most once, depending on whether the interrupt beat its dispatch.
  expect(executed.filter((entry) => entry !== "lookup:b")).toEqual([
    "lookup:a",
  ]);
  expect(executed.filter((entry) => entry === "lookup:b").length).toBeLessThan(
    2,
  );
}

// Each step says something before calling a tool: three silent tool-only
// steps in a row would trip the runtime's tool-loop fallback.
const steeredRounds = (): ChatStreamEvent[][] => [
  [text("Looking."), call("call-1", "lookup", "a")],
  [text("Trying the risky one."), call("call-2", "risky", "x")],
  [text("Looking again."), call("call-3", "lookup", "b")],
  [text("Carried on.")],
];

describe("a steered turn driven by commands alone (a4)", () => {
  it("submits, guides, denies an approval with a reason, interrupts, and submits again", async () => {
    const { session, events, requests, executed } =
      await createHeadlessSession(steeredRounds());
    const results: CommandResult[] = [];
    let commandNumber = 0;
    const send = (command: Record<string, unknown>) =>
      results.push(
        sendJson(session, {
          commandId: `c${++commandNumber}`,
          ...command,
        } as SessionCommand),
      );

    session.subscribe((event) => {
      if (event.type === "tool_started" && event.args.key === "a") {
        send({ type: "guide", text: "Only the 2024 records." });
      } else if (event.type === "approval_requested") {
        send({
          type: "answer_approval",
          answer: {
            requestId: event.request.id,
            decision: "deny",
            reason: "Not that one.",
          },
        });
      } else if (event.type === "tool_started" && event.args.key === "b") {
        send({ type: "interrupt" });
      }
    });

    send({ type: "submit", text: "Find the records" });
    await session.settled();
    send({ type: "submit", text: "Carry on" });
    await session.settled();

    expect(results.every((result) => result.accepted)).toBe(true);
    expect(results).toHaveLength(5);
    expectSteeredConversation(requests, executed, /Not that one\./);

    const own = events.filter((event) =>
      [
        "session_turn_started",
        "guidance_queued",
        "guidance_delivered",
        "approval_requested",
        "approval_resolved",
        "session_turn_ended",
      ].includes(event.type),
    );
    expect(own.map((event) => event.type)).toEqual([
      "session_turn_started",
      "guidance_queued",
      "guidance_delivered",
      "approval_requested",
      "approval_resolved",
      "session_turn_ended",
      "session_turn_started",
      "session_turn_ended",
    ]);
    expect(own[1]).toEqual({
      type: "guidance_queued",
      id: "c2",
      text: "Only the 2024 records.",
    });
    // The delivery carries the id of the command that queued it.
    expect(own[2]).toMatchObject({ type: "guidance_delivered", id: "c2" });
    expect(own[4]).toMatchObject({ resolution: "deny" });
    expect(own[5]).toMatchObject({
      type: "session_turn_ended",
      commandId: "c1",
      outcome: "cancelled",
      undelivered: [],
    });
    expect(own[7]).toEqual({
      type: "session_turn_ended",
      commandId: "c5",
      outcome: "completed",
      result: "Carried on.",
      undelivered: [],
    });
    // Everything a frontend is told survives the same trip as the commands.
    for (const event of events) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
  });

  describe("from another process", () => {
    const children: ChildProcessWithoutNullStreams[] = [];
    afterEach(() => {
      for (const child of children.splice(0)) child.kill();
    });

    it("is steered by a child that only exchanges JSON lines", async () => {
      let guidanceArrived!: () => void;
      const { session, requests, executed } = await createHeadlessSession(
        steeredRounds(),
        new Promise<void>((resolve) => {
          guidanceArrived = resolve;
        }),
      );
      const child = spawn(process.execPath, [
        fileURLToPath(new URL("./fixtures/commandChild.mjs", import.meta.url)),
      ]);
      children.push(child);
      const exited = new Promise<number | null>((resolve) =>
        child.on("exit", resolve),
      );
      const rejected: CommandResult[] = [];
      session.subscribe((event) => {
        child.stdin.write(`${JSON.stringify(event)}\n`);
        if (event.type === "guidance_queued") guidanceArrived();
      });
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        const parsed = parseSessionCommand(JSON.parse(line));
        if (!parsed.ok) throw new Error(parsed.message);
        const result = session.dispatch(parsed.command);
        if (!result.accepted) rejected.push(result);
      });

      expect(await exited).toBe(0);
      expect(rejected).toEqual([]);
      expectSteeredConversation(
        requests,
        executed,
        new RegExp(`child ${child.pid} refused risky`),
      );
    }, 20000);
  });
});

describe("command contract (a4)", () => {
  const valid: SessionCommand[] = [
    { type: "submit", commandId: "1", text: "Hello" },
    { type: "submit", commandId: "2", text: "", images: ["aGVsbG8="] },
    { type: "guide", commandId: "3", text: "Faster" },
    { type: "interrupt", commandId: "4" },
    {
      type: "answer_approval",
      commandId: "5",
      answer: { requestId: "r1", decision: "allow_once" },
    },
    {
      type: "answer_approval",
      commandId: "6",
      answer: { requestId: "r1", decision: "allow_session", rule: "bash" },
    },
    {
      type: "answer_approval",
      commandId: "7",
      answer: { requestId: "r1", decision: "allow_always", rule: "bash" },
    },
    {
      type: "answer_approval",
      commandId: "8",
      answer: { requestId: "r1", decision: "deny", reason: "No." },
    },
    {
      type: "answer_approval",
      commandId: "9",
      answer: { requestId: "r1", decision: "deny" },
    },
  ];

  it.each(valid)("round-trips $type ($commandId) through JSON", (command) => {
    const parsed = parseSessionCommand(JSON.parse(JSON.stringify(command)));
    expect(parsed).toEqual({ ok: true, command });
  });

  it.each([
    ["not an object", "text"],
    ["an array", []],
    ["a missing commandId", { type: "interrupt" }],
    ["an empty commandId", { type: "interrupt", commandId: "" }],
    ["an unknown type", { type: "resume", commandId: "1" }],
    ["an inherited type", { type: "toString", commandId: "1" }],
    ["a submit without text", { type: "submit", commandId: "1" }],
    [
      "an empty image",
      { type: "submit", commandId: "1", text: "", images: [""] },
    ],
    [
      "images that are bytes",
      { type: "submit", commandId: "1", text: "", images: [[1, 2, 3]] },
    ],
    ["empty guidance", { type: "guide", commandId: "1", text: "  " }],
    [
      "an unknown field",
      { type: "interrupt", commandId: "1", reason: "because" },
    ],
    ["a missing answer", { type: "answer_approval", commandId: "1" }],
    [
      "an unknown decision",
      {
        type: "answer_approval",
        commandId: "1",
        answer: { requestId: "r", decision: "maybe" },
      },
    ],
    [
      "a session grant without a rule",
      {
        type: "answer_approval",
        commandId: "1",
        answer: { requestId: "r", decision: "allow_session" },
      },
    ],
    [
      "an allow with a stray rule",
      {
        type: "answer_approval",
        commandId: "1",
        answer: { requestId: "r", decision: "allow_once", rule: "bash" },
      },
    ],
  ])("refuses %s", (_name, value) => {
    expect(parseSessionCommand(value).ok).toBe(false);
  });

  it("refuses a malformed command at dispatch without touching the session", () => {
    const session = new AgentSession({ runTurn: async () => "unused" });
    const result = session.dispatch({
      type: "guide",
      commandId: "g1",
      text: "",
    });
    expect(result).toMatchObject({
      commandId: "g1",
      accepted: false,
      code: "invalid",
    });
    expect(session.running).toBe(false);
  });

  it("carries images through a submit command as the strings they are", async () => {
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) % 256);
    const images = [
      "data:image/png;base64,aGVsbG8=",
      encodeCommandImage(bytes),
    ];
    let received: unknown;
    const session = new AgentSession({
      runTurn: async (submission) => {
        received = submission.images;
        return "ok";
      },
    });
    const command: SessionCommand = {
      type: "submit",
      commandId: "1",
      text: "Look",
      images,
    };
    session.dispatch(JSON.parse(JSON.stringify(command)));
    await session.settled();
    expect(received).toEqual(images);
    expect(Buffer.from(images[1]!, "base64")).toEqual(Buffer.from(bytes));
    expect(encodeCommandImage(new Uint8Array())).toBe("");
  });
});

describe("session controller", () => {
  /** A turn that stays open until released, exposing what it was given. */
  function heldSession() {
    let release!: (value: string) => void;
    let control!: Parameters<
      ConstructorParameters<typeof AgentSession<never>>[0]["runTurn"]
    >[1];
    const session = new AgentSession<never>({
      runTurn: (_submission, turnControl) => {
        control = turnControl;
        return new Promise<string>((resolve, reject) => {
          release = resolve;
          turnControl.abortSignal.addEventListener("abort", () =>
            reject(new Error("Request cancelled")),
          );
        });
      },
    });
    const events: SessionEvent<never>[] = [];
    session.subscribe((event) => events.push(event));
    return {
      session,
      events,
      release: (value: string) => release(value),
      control: () => control,
    };
  }
  const request = (id: string) => ({
    id,
    toolName: "bash",
    args: {},
    capabilities: ["process" as const],
    reason: "mode default",
    rule: "mode:ask",
    suggestions: [],
  });

  it("refuses commands that do not fit the session's state", async () => {
    const { session, release } = heldSession();
    expect(
      session.dispatch({ type: "guide", commandId: "1", text: "Hi" }),
    ).toMatchObject({ accepted: false, code: "no_turn" });
    expect(
      session.dispatch({ type: "interrupt", commandId: "2" }),
    ).toMatchObject({ accepted: false, code: "no_turn" });
    expect(
      session.dispatch({
        type: "answer_approval",
        commandId: "3",
        answer: { requestId: "nope", decision: "allow_once" },
      }),
    ).toMatchObject({ accepted: false, code: "unknown_approval" });

    expect(
      session.dispatch({ type: "submit", commandId: "4", text: "Go" }),
    ).toEqual({ commandId: "4", accepted: true });
    expect(
      session.dispatch({ type: "submit", commandId: "5", text: "Again" }),
    ).toMatchObject({ accepted: false, code: "turn_running" });

    release("done");
    await session.settled();
    expect(session.running).toBe(false);
    expect(
      session.dispatch({ type: "submit", commandId: "6", text: "Next" }),
    ).toMatchObject({ accepted: true });
    release("done");
    await session.settled();
  });

  it("hands guidance to the turn in order and reports what was never taken", async () => {
    const { session, events, control } = heldSession();
    session.dispatch({ type: "submit", commandId: "s", text: "Go" });
    session.dispatch({ type: "guide", commandId: "g1", text: "One" });
    session.dispatch({ type: "guide", commandId: "g2", text: "Two" });
    expect(control().guidance.drain()).toEqual([
      { id: "g1", text: "One" },
      { id: "g2", text: "Two" },
    ]);
    expect(control().guidance.drain()).toEqual([]);
    session.dispatch({ type: "guide", commandId: "g3", text: "Three" });

    expect(
      session.dispatch({ type: "interrupt", commandId: "i" }),
    ).toMatchObject({ accepted: true });
    expect(control().abortSignal.reason).toBe("interrupt");
    // Nothing more can be queued for a turn that is stopping.
    expect(
      session.dispatch({ type: "guide", commandId: "g4", text: "Four" }),
    ).toMatchObject({ accepted: false, code: "no_turn" });
    await session.settled();

    expect(events.at(-1)).toEqual({
      type: "session_turn_ended",
      commandId: "s",
      outcome: "cancelled",
      error: { name: "Error", message: "Request cancelled" },
      undelivered: [{ id: "g3", text: "Three" }],
    });
  });

  it("stops a turn for the host with the host's reason", async () => {
    const { session, events, control } = heldSession();
    expect(session.stop("shutdown")).toBe(false);
    session.dispatch({ type: "submit", commandId: "s", text: "Go" });
    const answer = session.approvalChannel.request(request("r1"));
    answer.catch(() => {});

    expect(session.stop("shutdown")).toBe(true);
    expect(control().abortSignal.reason).toBe("shutdown");
    await expect(answer).rejects.toThrow(/cancelled/);
    await session.settled();
    expect(events.at(-1)).toMatchObject({
      type: "session_turn_ended",
      outcome: "cancelled",
    });
  });

  it("reports a turn that fails, with the error as data", async () => {
    const session = new AgentSession<never>({
      runTurn: async () => {
        throw new TypeError("provider unavailable");
      },
    });
    const events: SessionEvent<never>[] = [];
    session.subscribe((event) => events.push(event));
    session.dispatch({ type: "submit", commandId: "s", text: "Go" });
    await session.settled();
    expect(events.at(-1)).toEqual({
      type: "session_turn_ended",
      commandId: "s",
      outcome: "failed",
      error: { name: "TypeError", message: "provider unavailable" },
      undelivered: [],
    });
  });

  it("withdraws a waiting approval when the turn is interrupted", async () => {
    const { session, events } = heldSession();
    session.dispatch({ type: "submit", commandId: "s", text: "Go" });
    const answer = session.approvalChannel.request(request("r1"));
    const outcome = answer.then(
      () => "answered",
      (error: Error) => error.message,
    );
    session.dispatch({ type: "interrupt", commandId: "i" });

    expect(await outcome).toMatch(/cancelled/);
    expect(events).toContainEqual({
      type: "approval_resolved",
      requestId: "r1",
      resolution: "withdrawn",
    });
    // The question is closed: a late answer has nothing to answer.
    expect(
      session.dispatch({
        type: "answer_approval",
        commandId: "a",
        answer: { requestId: "r1", decision: "allow_once" },
      }),
    ).toMatchObject({ accepted: false, code: "unknown_approval" });
    await session.settled();
  });

  it("withdraws a waiting approval when its own signal aborts", async () => {
    const { session, events, release } = heldSession();
    session.dispatch({ type: "submit", commandId: "s", text: "Go" });
    const controller = new AbortController();
    const answer = session.approvalChannel.request(
      request("r1"),
      controller.signal,
    );
    controller.abort();
    await expect(answer).rejects.toThrow(/cancelled/);
    expect(events.at(-1)).toMatchObject({ resolution: "withdrawn" });
    release("done");
    await session.settled();
  });

  it("answers each approval once", async () => {
    const { session, release } = heldSession();
    session.dispatch({ type: "submit", commandId: "s", text: "Go" });
    const answer = session.approvalChannel.request(request("r1"));
    const allow = {
      type: "answer_approval" as const,
      commandId: "a1",
      answer: { requestId: "r1", decision: "allow_once" as const },
    };
    expect(session.dispatch(allow)).toMatchObject({ accepted: true });
    expect(session.dispatch({ ...allow, commandId: "a2" })).toMatchObject({
      accepted: false,
      code: "unknown_approval",
    });
    await expect(answer).resolves.toEqual(allow.answer);
    release("done");
    await session.settled();
  });
});

describe("isolation and boundary (a7)", () => {
  it("keeps two sessions in one process apart", async () => {
    const make = (name: string) => {
      const seen: string[] = [];
      let finish!: () => void;
      let taken: unknown[] = [];
      const session = new AgentSession<never>({
        runTurn: (_submission, control) =>
          new Promise<string>((resolve) => {
            finish = () => {
              taken = [...control.guidance.drain()];
              resolve(name);
            };
          }),
      });
      session.subscribe((event) => seen.push(event.type));
      return { session, seen, finish: () => finish(), taken: () => taken };
    };
    const first = make("first");
    const second = make("second");
    first.session.dispatch({ type: "submit", commandId: "s", text: "Go" });
    second.session.dispatch({ type: "submit", commandId: "s", text: "Go" });

    first.session.dispatch({ type: "guide", commandId: "g", text: "For one" });
    const firstAnswer = first.session.approvalChannel.request({
      id: "shared-id",
      toolName: "bash",
      args: {},
      capabilities: ["process"],
      reason: "mode default",
      rule: "mode:ask",
      suggestions: [],
    });
    // The second session has no such request, even under the same id.
    expect(
      second.session.dispatch({
        type: "answer_approval",
        commandId: "a",
        answer: { requestId: "shared-id", decision: "allow_once" },
      }),
    ).toMatchObject({ accepted: false, code: "unknown_approval" });
    expect(second.seen).toEqual(["session_turn_started"]);

    first.session.dispatch({
      type: "answer_approval",
      commandId: "a",
      answer: { requestId: "shared-id", decision: "deny" },
    });
    await expect(firstAnswer).resolves.toMatchObject({ decision: "deny" });
    // Interrupting one leaves the other running.
    second.session.dispatch({ type: "interrupt", commandId: "i" });
    expect(first.session.running).toBe(true);

    first.finish();
    second.finish();
    await Promise.all([first.session.settled(), second.session.settled()]);
    expect(first.taken()).toEqual([{ id: "g", text: "For one" }]);
    expect(second.taken()).toEqual([]);
  });

  const directory = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sources = ["commands.ts", "session.ts"].map((name) => ({
    name,
    text: readFileSync(join(directory, name), "utf8"),
  }));
  const IMPORT =
    /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

  it("checks the files that hold the contract and the controller", () => {
    expect(readdirSync(directory)).toEqual(
      expect.arrayContaining(sources.map((source) => source.name)),
    );
  });

  it.each(sources)(
    "$name imports only agent-core siblings and policy types",
    ({ text }) => {
      const specifiers = [...text.matchAll(IMPORT)].map((match) => match[1]);
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier).toMatch(
          /^(?:\.\/(?:commands|events|input)\.js|\.\.\/policy\/index\.js)$/,
        );
      }
      // The policy import is types only, so nothing of it loads at run time.
      expect(text).not.toMatch(/import\s+\{[^}]*\}\s+from\s+["']\.\.\/policy/);
    },
  );

  it.each(sources)(
    "$name reads no keys and touches no process, file, network, or clock",
    ({ text }) => {
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const forbidden of [
        /\bprocess\s*[.[]/,
        /\bglobalThis\b/,
        /\brequire\s*\(/,
        /\bfetch\s*\(/,
        /\bDate\b/,
        /\bMath\.random\b/,
        /\bsetTimeout\b|\bsetInterval\b/,
        /["']node:/,
        /\breadline\b|\bstdin\b|\bkeypress\b/,
      ]) {
        expect(code).not.toMatch(forbidden);
      }
    },
  );

  it.each(sources)(
    "$name declares no mutable module-level state",
    ({ text }) => {
      expect(text).not.toMatch(/^(?:export\s+)?let\s/m);
      expect(text).not.toMatch(/^(?:export\s+)?var\s/m);
      // Module-level collections would be shared by every session.
      expect(text).not.toMatch(
        /^const\s+\w+\s*=\s*new\s+(?:Map|Set|WeakMap)\b/m,
      );
      expect(text).not.toMatch(/^const\s+\w+\s*(?::[^=]+)?=\s*\[\s*\]/m);
    },
  );
});
