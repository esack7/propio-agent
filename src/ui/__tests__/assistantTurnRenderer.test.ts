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
} from "../assistantTurnRenderer.js";
import { TerminalUi } from "../terminal.js";
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

describe("streamAssistantTurn", () => {
  it("renders streamed assistant tokens and preserves turn completion output", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Hello" },
      { type: "token", value: " world" },
    ]);

    const result = await streamAssistantTurn(
      agent,
      "say hi",
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
      "status test",
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
      { type: "token", value: "Alpha." },
      {
        type: "event",
        value: {
          type: "tool_started",
          toolName: "read",
          toolCallId: "tool_1",
          activityLabel: 'Reading src for "streamChat"',
          args: {},
          argumentChars: 12,
          argumentPreview: '{"q":"x"}',
        },
      },
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
      "activity test",
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
    const { ui, stderr } = createUi();
    const statusSpy = jest.spyOn(ui, "status");
    const doneSpy = jest.spyOn(ui, "done");
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Prelude." },
      ...readPackageJsonSteps(),
      { type: "token", value: "Tail." },
    ]);

    await streamAssistantTurn(
      agent,
      "hidden tool test",
      ui,
      new AbortController().signal,
      {
        ...defaultVisibility,
        showToolCalls: false,
      },
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output).toContain("Prelude.");
    expect(output).toContain("Tail.");
    expect(statusSpy).toHaveBeenCalledWith("Working", "tool call");
    expect(doneSpy).toHaveBeenCalledTimes(2);
    expect(output).not.toContain("Starting read...");
    expect(output).not.toContain("completed:");
  });

  it("keeps the hidden tool spinner active through consecutive tool calls in the same turn", async () => {
    const { ui, stderr } = createUi();
    const statusSpy = jest.spyOn(ui, "status");
    const doneSpy = jest.spyOn(ui, "done");
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Prelude." },
      ...readPackageJsonSteps(),
      ...grepMissingSteps(),
    ]);

    await streamAssistantTurn(
      agent,
      "hidden tool loop test",
      ui,
      new AbortController().signal,
      {
        ...defaultVisibility,
        showToolCalls: false,
      },
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output).toContain("Prelude.");
    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenNthCalledWith(1, "Working", "tool call");
    expect(doneSpy).toHaveBeenCalledTimes(2);
  });

  it("clears and restarts the hidden tool spinner when assistant text appears between tool calls", async () => {
    const { ui, stderr } = createUi();
    const statusSpy = jest.spyOn(ui, "status");
    const doneSpy = jest.spyOn(ui, "done");
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Prelude." },
      ...readPackageJsonSteps(),
      { type: "token", value: " Need one more check." },
      ...grepMissingSteps(),
      { type: "token", value: " Done." },
    ]);

    await streamAssistantTurn(
      agent,
      "hidden tool loop test",
      ui,
      new AbortController().signal,
      {
        ...defaultVisibility,
        showToolCalls: false,
      },
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output).toContain("Prelude.");
    expect(output).toContain("Need one more check.");
    expect(output).toContain("Done.");
    expect(statusSpy).toHaveBeenNthCalledWith(1, "Working", "tool call");
    expect(statusSpy).toHaveBeenNthCalledWith(2, "Working", "tool call");
    expect(doneSpy).toHaveBeenCalledTimes(3);
  });

  it("does not clear the hidden tool spinner for structural whitespace tokens between tool calls", async () => {
    const { ui, stderr } = createUi();
    const statusSpy = jest.spyOn(ui, "status");
    const doneSpy = jest.spyOn(ui, "done");
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Prelude." },
      ...readPackageJsonSteps(),
      { type: "token", value: "\n" },
      ...grepMissingSteps(),
      { type: "token", value: " Done." },
    ]);

    await streamAssistantTurn(
      agent,
      "hidden structural newline test",
      ui,
      new AbortController().signal,
      {
        ...defaultVisibility,
        showToolCalls: false,
      },
    );

    const output = normalizeOutput(stderr.chunks);

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
      "tool test",
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
      "tool text resume test",
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
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Alpha." },
      {
        type: "event",
        value: {
          type: "tool_started",
          toolName: "read",
          toolCallId: "tool_1",
          activityLabel: 'Reading src for "streamChat"',
          args: {},
          argumentChars: 12,
          argumentPreview: '{"q":"x"}',
        },
      },
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
    ]);

    await streamAssistantTurn(
      agent,
      "activity hidden test",
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
      "failure test",
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
      "prompt plan test",
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
      "reasoning test",
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
      "empty response",
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
      [{ type: "token", value: "json response" }],
      {
        reasoningSummary: {
          summary: "provider summary",
          source: "provider",
        },
      },
    );

    const result = await streamAssistantTurn(
      agent,
      "json test",
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
