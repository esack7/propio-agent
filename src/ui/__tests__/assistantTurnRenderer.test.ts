import type {
  AgentVisibilityEvent,
  PromptPlanSnapshot,
  TurnReasoningSummary,
} from "../../agent.js";
import type { ConversationState } from "../../context/types.js";
import {
  streamAssistantTurn,
  type AssistantTurnAgent,
  type AssistantTurnVisibilityOptions,
  type AssistantTurnVisibilitySource,
} from "../assistantTurnRenderer.js";
import { TerminalUi } from "../terminal.js";
import { createPlainSubmission } from "../input/promptSubmission.js";
import { createTtyTestStream, stripAnsi } from "./ttyTestStream.js";

type ScriptStep =
  | { type: "token"; value: string }
  | { type: "event"; value: AgentVisibilityEvent };

class ScriptedAssistantTurnAgent implements AssistantTurnAgent {
  constructor(
    private readonly steps: ReadonlyArray<ScriptStep>,
    private readonly options: {
      response?: string;
      reasoningSummary?: TurnReasoningSummary | null;
      conversationState?: ConversationState;
    } = {},
  ) {}

  async streamChat(
    _userInput: string,
    onToken: (token: string) => void,
    callbacks?: {
      onEvent?: (event: AgentVisibilityEvent) => void;
      abortSignal?: AbortSignal;
    },
  ): Promise<string> {
    let response = "";

    for (const step of this.steps) {
      switch (step.type) {
        case "token":
          response += step.value;
          onToken(step.value);
          break;
        case "event":
          callbacks?.onEvent?.(step.value);
          break;
      }
    }

    return this.options.response ?? response;
  }

  getLastTurnReasoningSummary(): TurnReasoningSummary | null {
    return this.options.reasoningSummary ?? null;
  }

  getConversationState(): ConversationState {
    return this.options.conversationState ?? emptyConversationState();
  }
}

class ThrowingAssistantTurnAgent implements AssistantTurnAgent {
  constructor(
    private readonly onStreamStep?: (
      callbacks:
        | { onEvent?: (event: AgentVisibilityEvent) => void }
        | undefined,
    ) => void,
  ) {}

  async streamChat(
    _userInput: string,
    _onToken: (token: string) => void,
    callbacks?: {
      onEvent?: (event: AgentVisibilityEvent) => void;
      abortSignal?: AbortSignal;
    },
  ): Promise<string> {
    callbacks?.onEvent?.({
      type: "thinking_delta",
      delta: "Reasoning before failure.",
    });
    this.onStreamStep?.(callbacks);
    throw new Error("stream failed");
  }

  getLastTurnReasoningSummary(): TurnReasoningSummary | null {
    return null;
  }

  getConversationState(): ConversationState {
    return emptyConversationState();
  }
}

function createUi(
  options: {
    interactive?: boolean;
    plain?: boolean;
    json?: boolean;
  } = {},
) {
  const stdout = createTtyTestStream();
  const stderr = createTtyTestStream();
  const ui = new TerminalUi({
    interactive: options.interactive ?? true,
    plain: options.plain ?? false,
    json: options.json ?? false,
    stdout,
    stderr,
  });

  return { ui, stdout, stderr };
}

function normalizeOutput(chunks: readonly string[]): string {
  return stripAnsi(chunks.join("")).replace(/\r/g, "");
}

function emptyConversationState(): ConversationState {
  return {
    preamble: [],
    turns: [],
    artifacts: [],
    pinnedMemory: [],
  };
}

function createInlineAssistantTurnAgent(
  streamChat: AssistantTurnAgent["streamChat"],
  options: {
    reasoningSummary?: TurnReasoningSummary | null;
    conversationState?: ConversationState;
  } = {},
): AssistantTurnAgent {
  return {
    streamChat,
    getLastTurnReasoningSummary: () => options.reasoningSummary ?? null,
    getConversationState: () =>
      options.conversationState ?? emptyConversationState(),
  };
}

async function runInlineAssistantTurn(options: {
  ui: TerminalUi;
  streamChat: AssistantTurnAgent["streamChat"];
  userInput: string;
  abortSignal?: AbortSignal;
  visibility: AssistantTurnVisibilitySource;
}): Promise<string> {
  const agent = createInlineAssistantTurnAgent(options.streamChat);

  return streamAssistantTurn(
    agent,
    createPlainSubmission(options.userInput, "prompt"),
    options.ui,
    options.abortSignal ?? new AbortController().signal,
    options.visibility,
  );
}

async function runPlainThinkingOutputTest(options: {
  userInput: string;
  visibility: AssistantTurnVisibilityOptions;
  forbiddenSubstrings: readonly string[];
}): Promise<string> {
  const { ui, stderr } = createUi({ interactive: false, plain: true });
  const agent = new ScriptedAssistantTurnAgent(
    [
      thinkingStep("Reasoning that should stay hidden."),
      { type: "token", value: "Final answer." },
    ],
    { response: "Final answer." },
  );

  await streamAssistantTurn(
    agent,
    createPlainSubmission(options.userInput, "prompt"),
    ui,
    new AbortController().signal,
    options.visibility,
  );

  const output = normalizeOutput(stderr.chunks);
  for (const forbidden of options.forbiddenSubstrings) {
    expect(output).not.toContain(forbidden);
  }

  return output;
}

async function runInlineAssistantTurnAndNormalize(options: {
  ui: TerminalUi;
  stderr: { chunks: string[] };
  streamChat: AssistantTurnAgent["streamChat"];
  userInput: string;
  visibility:
    | AssistantTurnVisibilityOptions
    | (() => AssistantTurnVisibilityOptions);
}): Promise<string> {
  await runInlineAssistantTurn(options);
  return normalizeOutput(options.stderr.chunks);
}

function createPromptPlanSnapshot(): PromptPlanSnapshot {
  return {
    provider: "mock",
    model: "model-a",
    iteration: 1,
    contextWindowTokens: 128000,
    availableInputBudget: 125952,
    plan: {
      messages: [{ role: "user", content: "hello" }],
      estimatedPromptTokens: 42,
      reservedOutputTokens: 2048,
      includedTurnIds: ["turn_1"],
      includedArtifactIds: [],
      omittedTurnIds: [],
      usedRollingSummary: false,
      retryLevel: 0,
    },
  };
}

const defaultVisibility: AssistantTurnVisibilityOptions = {
  showToolCalls: true,
  showThinking: true,
  showStatus: false,
  showReasoningSummary: false,
  showContextStats: false,
  showPromptPlan: false,
};

function toolStartedStep(
  toolName: string,
  toolCallId: string,
  activityLabel: string,
  argumentPreview = "",
): ScriptStep {
  return {
    type: "event",
    value: {
      type: "tool_started",
      toolName,
      toolCallId,
      activityLabel,
      args: {},
      argumentChars: argumentPreview.length,
      argumentPreview,
    },
  };
}

function toolFinishedStep(
  toolName: string,
  toolCallId: string,
  activityLabel: string,
  resultPreview: string,
): ScriptStep {
  return {
    type: "event",
    value: {
      type: "tool_finished",
      toolName,
      toolCallId,
      activityLabel,
      resultPreview,
    },
  };
}

function thinkingStep(value: string): ScriptStep {
  return {
    type: "event",
    value: {
      type: "thinking_delta",
      delta: value,
    },
  };
}

function readPackageJsonSteps(): ScriptStep[] {
  return [
    toolStartedStep(
      "read",
      "tool_1",
      "Reading package.json",
      '{"path":"package.json"}',
    ),
    toolFinishedStep(
      "read",
      "tool_1",
      "Reading package.json",
      "package content",
    ),
  ];
}

function grepMissingSteps(): ScriptStep[] {
  return [
    toolStartedStep(
      "grep",
      "tool_2",
      'Searching src for "missing"',
      '{"pattern":"missing"}',
    ),
    toolFinishedStep(
      "grep",
      "tool_2",
      'Searching src for "missing"',
      "no matches",
    ),
  ];
}

function readStreamChatStartSteps(): ScriptStep[] {
  return [
    { type: "token", value: "Alpha." },
    toolStartedStep(
      "read",
      "tool_1",
      'Reading src for "streamChat"',
      '{"q":"x"}',
    ),
  ];
}

function readStreamChatSteps(resultPreview = "match found"): ScriptStep[] {
  return [
    ...readStreamChatStartSteps(),
    toolFinishedStep(
      "read",
      "tool_1",
      'Reading src for "streamChat"',
      resultPreview,
    ),
  ];
}

async function runHiddenToolScenario(
  steps: ReadonlyArray<ScriptStep>,
  userInput: string,
): Promise<{
  output: string;
  statusSpy: jest.SpiedFunction<TerminalUi["status"]>;
  doneSpy: jest.SpiedFunction<TerminalUi["done"]>;
}> {
  const { ui, stderr } = createUi();
  const statusSpy = jest.spyOn(ui, "status");
  const doneSpy = jest.spyOn(ui, "done");
  const agent = new ScriptedAssistantTurnAgent(steps);

  await streamAssistantTurn(
    agent,
    createPlainSubmission(userInput, "prompt"),
    ui,
    new AbortController().signal,
    {
      ...defaultVisibility,
      showToolCalls: false,
      showThinking: false,
    },
  );

  return {
    output: normalizeOutput(stderr.chunks),
    statusSpy,
    doneSpy,
  };
}

describe("streamAssistantTurn", () => {
  it("renders streamed assistant tokens and preserves turn completion output", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Hello" },
      { type: "token", value: " world" },
    ]);

    const result = await streamAssistantTurn(
      agent,
      createPlainSubmission("say hi", "prompt"),
      ui,
      new AbortController().signal,
      defaultVisibility,
    );
    ui.turnComplete(4200);

    const output = normalizeOutput(stderr.chunks);

    expect(result.response).toBe("Hello world");
    expect(output).toContain("Hello world");
    expect(output).toContain("Turn complete in 4.2s");
  });

  it("flushes markdown before status traces are rendered", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Before status." },
      { type: "event", value: { type: "status", status: "Querying" } },
      { type: "token", value: " After status." },
    ]);

    await streamAssistantTurn(
      agent,
      createPlainSubmission("status test", "prompt"),
      ui,
      new AbortController().signal,
      { ...defaultVisibility, showStatus: true },
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output.indexOf("Before status.")).toBeGreaterThan(-1);
    expect(output.indexOf("After status.")).toBeGreaterThan(
      output.indexOf("Before status."),
    );
    expect(output).not.toContain("Status: Querying");
  });

  it("flushes markdown before activity traces are rendered", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent([
      ...readStreamChatStartSteps(),
      { type: "token", value: " Beta." },
      {
        type: "event",
        value: {
          type: "tool_finished",
          toolName: "read",
          toolCallId: "tool_1",
          activityLabel: 'Reading src for "streamChat"',
          resultPreview: "match found",
        },
      },
      {
        type: "event",
        value: {
          type: "tool_failed",
          toolName: "grep",
          toolCallId: "tool_2",
          activityLabel: 'Searching src for "missing"',
          resultPreview: "no matches",
        },
      },
    ]);

    await streamAssistantTurn(
      agent,
      createPlainSubmission("activity test", "prompt"),
      ui,
      new AbortController().signal,
      defaultVisibility,
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output.indexOf("Alpha.")).toBeGreaterThan(-1);
    expect(output.indexOf('Reading src for "streamChat"')).toBeGreaterThan(
      output.indexOf("Alpha."),
    );
    expect(output.indexOf("Beta.")).toBeGreaterThan(
      output.indexOf('Reading src for "streamChat"'),
    );
    expect(output).toContain("match found");
    expect(output).toContain("no matches");
  });

  it("shows working spinner when tool calls are hidden", async () => {
    const { output, statusSpy, doneSpy } = await runHiddenToolScenario(
      [
        { type: "token", value: "Prelude." },
        ...readPackageJsonSteps(),
        { type: "token", value: "Tail." },
      ],
      "hidden tool test",
    );

    expect(output).toContain("Prelude.");
    expect(output).toContain("Tail.");
    expect(statusSpy).toHaveBeenCalledWith("Working", "tool call");
    expect(doneSpy).toHaveBeenCalledTimes(2);
    expect(output).not.toContain("Starting read...");
    expect(output).not.toContain("completed:");
  });

  it("shows a thinking spinner before hidden answer text arrives", async () => {
    const { output, statusSpy, doneSpy } = await runHiddenToolScenario(
      [thinkingStep("Reasoning."), { type: "token", value: "Answer." }],
      "hidden thinking test",
    );

    expect(output).toContain("Answer.");
    expect(statusSpy).toHaveBeenCalledWith("Thinking", "thinking");
    expect(doneSpy).toHaveBeenCalledTimes(2);
  });

  it("does not show a thinking spinner for token-only streams", async () => {
    const { ui } = createUi();
    const statusSpy = jest.spyOn(ui, "status");
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Answer." },
    ]);

    await streamAssistantTurn(
      agent,
      createPlainSubmission("non-thinking stream", "prompt"),
      ui,
      new AbortController().signal,
      defaultVisibility,
    );

    expect(statusSpy).not.toHaveBeenCalledWith("Thinking", "thinking");
  });

  it("hands hidden thinking back off after a hidden tool finishes", async () => {
    const { output, statusSpy, doneSpy } = await runHiddenToolScenario(
      [
        toolStartedStep(
          "read",
          "tool_1",
          "Reading package.json",
          '{"path":"package.json"}',
        ),
        toolFinishedStep(
          "read",
          "tool_1",
          "Reading package.json",
          "package content",
        ),
        thinkingStep("More reasoning."),
        { type: "token", value: "Answer." },
      ],
      "hidden tool thinking handoff",
    );

    expect(output).toContain("Answer.");
    expect(statusSpy).toHaveBeenNthCalledWith(1, "Working", "tool call");
    expect(statusSpy).toHaveBeenNthCalledWith(2, "Thinking", "thinking");
    expect(doneSpy).toHaveBeenCalled();
  });

  it("renders visible thinking separately from assistant text", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent(
      [
        thinkingStep("Reasoning 1."),
        { type: "token", value: "Final answer." },
        thinkingStep(" More reasoning."),
      ],
      { response: "Final answer." },
    );

    await streamAssistantTurn(
      agent,
      createPlainSubmission("thinking test", "prompt"),
      ui,
      new AbortController().signal,
      {
        ...defaultVisibility,
        showThinking: true,
      },
    );

    const output = normalizeOutput(stderr.chunks);
    expect(output.indexOf("Reasoning 1.")).toBeGreaterThan(-1);
    expect(output.indexOf("Final answer.")).toBeGreaterThan(-1);
    expect(output.indexOf("Reasoning 1.")).toBeLessThan(
      output.indexOf("Final answer."),
    );
    expect(output).toContain("More reasoning.");
    expect(output.indexOf("More reasoning.")).toBeGreaterThan(
      output.indexOf("Final answer."),
    );
  });

  it("suppresses visible thinking in plain non-interactive output", async () => {
    const output = await runPlainThinkingOutputTest({
      userInput: "plain thinking test",
      visibility: { ...defaultVisibility, showThinking: true },
      forbiddenSubstrings: ["Reasoning that should stay hidden.", "Thinking:"],
    });

    expect(output).toContain("Final answer.");
  });

  it("keeps hidden thinking silent in plain non-interactive output", async () => {
    const output = await runPlainThinkingOutputTest({
      userInput: "plain hidden thinking test",
      visibility: { ...defaultVisibility, showThinking: false },
      forbiddenSubstrings: ["Reasoning that should stay hidden.", "Thinking"],
    });

    expect(output).toContain("Final answer.");
  });

  it("applies thinking visibility changes to future deltas during a turn", async () => {
    const { ui, stderr } = createUi();
    let showThinking = true;
    const output = await runInlineAssistantTurnAndNormalize({
      ui,
      stderr,
      userInput: "live thinking toggle",
      visibility: () => ({
        ...defaultVisibility,
        showThinking,
      }),
      streamChat: async (_userInput, onToken, callbacks) => {
        callbacks?.onEvent?.({
          type: "thinking_delta",
          delta: "Visible reasoning.",
        });
        showThinking = false;
        callbacks?.onEvent?.({
          type: "thinking_delta",
          delta: " Hidden reasoning.",
        });
        onToken("Final answer.");
        return "Final answer.";
      },
    });

    expect(output).toContain("Visible reasoning.");
    expect(output).not.toContain("Hidden reasoning.");
    expect(output).toContain("Final answer.");
  });

  it("streams answer text immediately while visible thinking remains enabled", async () => {
    const { ui } = createUi();
    const beginAssistantSpy = jest.spyOn(ui, "beginAssistantResponse");

    await runInlineAssistantTurn({
      ui,
      userInput: "visible thinking streams answer",
      visibility: { ...defaultVisibility, showThinking: true },
      streamChat: async (_userInput, onToken, callbacks) => {
        callbacks?.onEvent?.({
          type: "thinking_delta",
          delta: "Visible reasoning.",
        });
        onToken("Final answer.");
        expect(beginAssistantSpy).toHaveBeenCalled();
        return "Final answer.";
      },
    });
  });

  it("commits tool output as transcript lines while visible thinking is streaming", async () => {
    const { ui, stderr } = createUi();
    const beginThinkingSpy = jest.spyOn(ui, "beginThinkingResponse");
    const appendToolSpy = jest.spyOn(ui, "appendToolCallView");
    const upsertToolSpy = jest.spyOn(ui, "upsertToolCallView");
    const agent = new ScriptedAssistantTurnAgent([
      thinkingStep("Thinking before tool."),
      ...readPackageJsonSteps(),
      thinkingStep("Thinking after tool."),
      { type: "token", value: "Final answer." },
    ]);

    await streamAssistantTurn(
      agent,
      createPlainSubmission("visible thinking and tools", "prompt"),
      ui,
      new AbortController().signal,
      {
        ...defaultVisibility,
        showThinking: true,
      },
    );

    const output = normalizeOutput(stderr.chunks);

    expect(appendToolSpy).toHaveBeenCalledTimes(2);
    expect(upsertToolSpy).not.toHaveBeenCalled();
    expect(beginThinkingSpy).toHaveBeenCalledTimes(2);
    expect(output.indexOf("Thinking before tool.")).toBeLessThan(
      output.indexOf("Reading package.json"),
    );
    expect(output.indexOf("package content")).toBeLessThan(
      output.indexOf("Thinking after tool."),
    );
    expect(output).toContain("Final answer.");
  });

  it("requests provider reasoning when visible thinking is enabled", async () => {
    const { ui } = createUi();

    await runInlineAssistantTurn({
      ui,
      userInput: "request thinking",
      visibility: defaultVisibility,
      streamChat: async (_userInput, onToken, callbacks) => {
        expect(callbacks?.requestReasoning).toBe(true);
        onToken("Final answer.");
        return "Final answer.";
      },
    });
  });

  it("cleans up hidden status surfaces when the stream fails", async () => {
    const { ui } = createUi();
    const doneSpy = jest.spyOn(ui, "done");
    const statusSpy = jest.spyOn(ui, "status");
    const agent = new ThrowingAssistantTurnAgent();

    await expect(
      streamAssistantTurn(
        agent,
        createPlainSubmission("failing thinking stream", "prompt"),
        ui,
        new AbortController().signal,
        { ...defaultVisibility, showThinking: false },
      ),
    ).rejects.toThrow("stream failed");

    expect(statusSpy).toHaveBeenCalledWith("Thinking", "thinking");
    expect(doneSpy).toHaveBeenCalled();
  });

  it("cleans up hidden status surfaces when the stream is aborted", async () => {
    const { ui } = createUi();
    const doneSpy = jest.spyOn(ui, "done");
    const abortController = new AbortController();
    await expect(
      runInlineAssistantTurn({
        ui,
        abortSignal: abortController.signal,
        userInput: "aborted thinking stream",
        visibility: { ...defaultVisibility, showThinking: false },
        streamChat: async (_userInput, _onToken, callbacks) => {
          callbacks?.onEvent?.({
            type: "thinking_delta",
            delta: "Reasoning before cancel.",
          });
          abortController.abort();
          if (callbacks?.abortSignal?.aborted) {
            throw new Error("Request cancelled");
          }
          return "";
        },
      }),
    ).rejects.toThrow("Request cancelled");

    expect(doneSpy).toHaveBeenCalled();
  });

  it("keeps the hidden tool spinner active through consecutive tool calls in the same turn", async () => {
    const { output, statusSpy, doneSpy } = await runHiddenToolScenario(
      [
        { type: "token", value: "Prelude." },
        ...readPackageJsonSteps(),
        ...grepMissingSteps(),
      ],
      "hidden tool loop test",
    );

    expect(output).toContain("Prelude.");
    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenNthCalledWith(1, "Working", "tool call");
    expect(doneSpy).toHaveBeenCalledTimes(2);
  });

  it("clears and restarts the hidden tool spinner when assistant text appears between tool calls", async () => {
    const { output, statusSpy, doneSpy } = await runHiddenToolScenario(
      [
        { type: "token", value: "Prelude." },
        ...readPackageJsonSteps(),
        { type: "token", value: " Need one more check." },
        ...grepMissingSteps(),
        { type: "token", value: " Done." },
      ],
      "hidden tool loop test",
    );

    expect(output).toContain("Prelude.");
    expect(output).toContain("Need one more check.");
    expect(output).toContain("Done.");
    expect(statusSpy).toHaveBeenNthCalledWith(1, "Working", "tool call");
    expect(statusSpy).toHaveBeenNthCalledWith(2, "Working", "tool call");
    expect(doneSpy).toHaveBeenCalledTimes(3);
  });

  it("does not clear the hidden tool spinner for structural whitespace tokens between tool calls", async () => {
    const { output, statusSpy, doneSpy } = await runHiddenToolScenario(
      [
        { type: "token", value: "Prelude." },
        ...readPackageJsonSteps(),
        { type: "token", value: "\n" },
        ...grepMissingSteps(),
        { type: "token", value: " Done." },
      ],
      "hidden structural newline test",
    );

    expect(output).toContain("Prelude.");
    expect(output).toContain("Done.");
    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenNthCalledWith(1, "Working", "tool call");
    expect(doneSpy).toHaveBeenCalledTimes(2);
  });

  it("renders tool start and completion via visibility events", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Using a tool." },
      {
        type: "event",
        value: {
          type: "tool_started",
          toolName: "read",
          toolCallId: "tool_1",
          activityLabel: "Reading package.json",
          args: {},
          argumentChars: 12,
          argumentPreview: '{"path":"package.json"}',
        },
      },
      {
        type: "event",
        value: {
          type: "tool_finished",
          toolName: "read",
          toolCallId: "tool_1",
          activityLabel: "Reading package.json",
          resultPreview: "package content",
        },
      },
    ]);

    await streamAssistantTurn(
      agent,
      createPlainSubmission("tool test", "prompt"),
      ui,
      new AbortController().signal,
      defaultVisibility,
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output).toContain("Reading package.json");
    expect(output).toContain("package content");
  });

  it("clears retained tool call output before assistant text resumes", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Prelude." },
      {
        type: "event",
        value: {
          type: "tool_started",
          toolName: "read",
          toolCallId: "tool_1",
          activityLabel: "Reading package.json",
          useLabel: "package.json",
          args: {},
          argumentChars: 12,
          argumentPreview: '{"path":"package.json"}',
        },
      },
      {
        type: "event",
        value: {
          type: "tool_finished",
          toolName: "read",
          toolCallId: "tool_1",
          activityLabel: "Reading package.json",
          resultPreview: "Read 1 line",
        },
      },
      { type: "token", value: "Final answer." },
    ]);

    await streamAssistantTurn(
      agent,
      createPlainSubmission("tool text resume test", "prompt"),
      ui,
      new AbortController().signal,
      defaultVisibility,
    );
    ui.turnComplete(1000);

    const rawOutput = stderr.chunks.join("");
    const output = normalizeOutput(stderr.chunks);

    expect(output).toContain("Final answer.");
    expect(output).toContain("Turn complete in 1.0s");
    expect(rawOutput).not.toContain("Final answer.\x1b[1G\x1b[2K");
  });

  it("suppresses all tool call UI when tool calls are hidden", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent(readStreamChatSteps());

    await streamAssistantTurn(
      agent,
      createPlainSubmission("activity hidden test", "prompt"),
      ui,
      new AbortController().signal,
      { ...defaultVisibility, showToolCalls: false },
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output).toContain("Alpha.");
    expect(output).not.toContain("Reading src");
    expect(output).not.toContain("match found");
  });

  it("renders failed tool activity via visibility events", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Using a tool." },
      {
        type: "event",
        value: {
          type: "tool_started",
          toolName: "grep",
          toolCallId: "tool_9",
          activityLabel: 'Searching src for "missing"',
          args: {},
          argumentChars: 16,
          argumentPreview: '{"pattern":"missing"}',
        },
      },
      {
        type: "event",
        value: {
          type: "tool_failed",
          toolName: "grep",
          toolCallId: "tool_9",
          activityLabel: 'Searching src for "missing"',
          resultPreview: "No matches found.",
        },
      },
    ]);

    await streamAssistantTurn(
      agent,
      createPlainSubmission("failure test", "prompt"),
      ui,
      new AbortController().signal,
      defaultVisibility,
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output).toContain('Searching src for "missing"');
    expect(output).toContain("No matches found.");
  });

  it("renders prompt-plan output on its own line after flushing assistant content", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Prelude." },
      {
        type: "event",
        value: {
          type: "prompt_plan_built",
          snapshot: createPromptPlanSnapshot(),
        },
      },
      { type: "token", value: "Tail." },
    ]);

    await streamAssistantTurn(
      agent,
      createPlainSubmission("prompt plan test", "prompt"),
      ui,
      new AbortController().signal,
      { ...defaultVisibility, showPromptPlan: true },
    );

    const output = normalizeOutput(stderr.chunks);
    const lines = output.split("\n");

    expect(lines.some((line) => line.includes("Prelude."))).toBe(true);
    expect(
      lines.some((line) => line.includes("Prompt plan: mock/model-a")),
    ).toBe(true);
    expect(lines.some((line) => line.includes("Tail."))).toBe(true);
    expect(output.indexOf("Prompt plan: mock/model-a")).toBeGreaterThan(
      output.indexOf("Prelude."),
    );
  });

  it("renders reasoning summary and context stats after assistant content", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent(
      [{ type: "token", value: "Final answer." }],
      {
        reasoningSummary: {
          summary: "Used the gathered context.",
          source: "agent",
        },
      },
    );

    await streamAssistantTurn(
      agent,
      createPlainSubmission("reasoning test", "prompt"),
      ui,
      new AbortController().signal,
      {
        ...defaultVisibility,
        showReasoningSummary: true,
        showContextStats: true,
      },
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output.indexOf("Final answer.")).toBeGreaterThan(-1);
    expect(
      output.indexOf("Reasoning summary (agent): Used the gathered context."),
    ).toBeGreaterThan(output.indexOf("Final answer."));
    expect(output.indexOf("Context: 0 turns")).toBeGreaterThan(
      output.indexOf("Reasoning summary (agent): Used the gathered context."),
    );
  });

  it("warns when the assistant response is empty", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent([], { response: "" });

    await streamAssistantTurn(
      agent,
      createPlainSubmission("empty response", "prompt"),
      ui,
      new AbortController().signal,
      defaultVisibility,
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output).toContain("Assistant returned an empty response.");
  });

  it("suppresses human-readable output in JSON mode while returning the response", async () => {
    const { ui, stdout, stderr } = createUi({ json: true });
    const agent = new ScriptedAssistantTurnAgent(
      [
        thinkingStep("Planning in JSON."),
        { type: "token", value: "json response" },
      ],
      {
        reasoningSummary: {
          summary: "provider summary",
          source: "provider",
        },
      },
    );

    const result = await streamAssistantTurn(
      agent,
      createPlainSubmission("json test", "prompt"),
      ui,
      new AbortController().signal,
      {
        ...defaultVisibility,
        showReasoningSummary: true,
        showContextStats: true,
        showStatus: true,
        showPromptPlan: true,
      },
    );

    expect(result.response).toBe("json response");
    expect(result.reasoningSummary).toEqual({
      summary: "provider summary",
      source: "provider",
    });
    expect(stderr.chunks.join("")).toBe("");
    expect(stdout.chunks.join("")).toBe("");
  });
});
