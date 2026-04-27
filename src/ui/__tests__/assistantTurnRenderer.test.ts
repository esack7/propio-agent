import type {
  AgentVisibilityEvent,
  PromptPlanSnapshot,
  TurnReasoningSummary,
} from "../../agent.js";
import type { ConversationState } from "../../context/types.js";
import type { ToolExecutionStatus } from "../../tools/types.js";
import {
  streamAssistantTurn,
  type AssistantTurnAgent,
  type AssistantTurnVisibilityOptions,
} from "../assistantTurnRenderer.js";
import { TerminalUi } from "../terminal.js";
import { createTtyTestStream, stripAnsi } from "./ttyTestStream.js";

type ScriptStep =
  | { type: "token"; value: string }
  | { type: "event"; value: AgentVisibilityEvent }
  | { type: "tool_start"; toolName: string }
  | {
      type: "tool_end";
      toolName: string;
      result: string;
      status: ToolExecutionStatus;
    };

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
      onToolStart?: (toolName: string) => void;
      onToolEnd?: (
        toolName: string,
        result: string,
        status: ToolExecutionStatus,
      ) => void;
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
        case "tool_start":
          callbacks?.onToolStart?.(step.toolName);
          break;
        case "tool_end":
          callbacks?.onToolEnd?.(step.toolName, step.result, step.status);
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
  showActivity: false,
  showStatus: false,
  showReasoningSummary: false,
  showContextStats: false,
  showPromptPlan: false,
};

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
      { ...defaultVisibility, showActivity: true },
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output.indexOf("Alpha.")).toBeGreaterThan(-1);
    expect(
      output.indexOf('Activity: Starting Reading src for "streamChat"'),
    ).toBeGreaterThan(output.indexOf("Alpha."));
    expect(output.indexOf("Beta.")).toBeGreaterThan(
      output.indexOf('Activity: Starting Reading src for "streamChat"'),
    );
    expect(output).toContain(
      'Activity: Finished Reading src for "streamChat": match found',
    );
    expect(output).toContain(
      'Activity: Failed Searching src for "missing": no matches',
    );
    expect(output).not.toContain("Starting read...");
    expect(output).not.toContain("read completed:");
  });

  it("renders rich tool labels in legacy callback output when visibility events are available", async () => {
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
          argumentChars: 12,
          argumentPreview: '{"path":"package.json"}',
        },
      },
      { type: "tool_start", toolName: "read" },
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
      {
        type: "tool_end",
        toolName: "read",
        result:
          "This is a long result payload that will be summarized in output.",
        status: "success",
      },
    ]);

    await streamAssistantTurn(
      agent,
      "legacy tool test",
      ui,
      new AbortController().signal,
      defaultVisibility,
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output).toContain("Starting Reading package.json...");
    expect(output).toContain("Executing Reading package.json...");
    expect(output).toContain(
      "Reading package.json completed: This is a long result payload",
    );
    expect(output).not.toContain("Starting read...");
    expect(output).not.toContain("read completed:");
  });

  it("falls back to raw tool names when visibility events are missing", async () => {
    const { ui, stderr } = createUi();
    const agent = new ScriptedAssistantTurnAgent([
      { type: "token", value: "Using a tool." },
      { type: "tool_start", toolName: "read" },
      {
        type: "tool_end",
        toolName: "read",
        result:
          "This is a long result payload that will be summarized in output.",
        status: "success",
      },
    ]);

    await streamAssistantTurn(
      agent,
      "legacy tool test",
      ui,
      new AbortController().signal,
      defaultVisibility,
    );

    const output = normalizeOutput(stderr.chunks);

    expect(output).toContain("Starting read...");
    expect(output).toContain("Executing read...");
    expect(output).toContain("read completed: This is a long result payload");
  });

  it("uses the rich label for failed tools in legacy callback output", async () => {
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
          argumentChars: 16,
          argumentPreview: '{"pattern":"missing"}',
        },
      },
      { type: "tool_start", toolName: "grep" },
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
      {
        type: "tool_end",
        toolName: "grep",
        result: "No matches found.",
        status: "error",
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

    expect(output).toContain('Starting Searching src for "missing"...');
    expect(output).toContain('Executing Searching src for "missing"...');
    expect(output).toContain(
      'Searching src for "missing" failed: No matches found.',
    );
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
        showActivity: true,
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
