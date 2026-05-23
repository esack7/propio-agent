import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { PromptRequest, PromptResult } from "../ui/promptComposer.js";
import type { RuntimeConfig } from "../config/runtimeConfig.js";
import { createAbortStateController } from "../ui/abortState.js";

const mockCompose = jest.fn<() => Promise<PromptResult>>();
const mockProcessBashCommand = jest.fn<() => Promise<void>>();
const mockCreateTurnCancelListener = jest.fn();

jest.unstable_mockModule("../ui/promptComposer.js", () => ({
  createPromptComposer: jest.fn(() => ({
    compose: mockCompose,
    confirm: jest.fn(),
    getState: jest.fn(() => null),
    getCloseReason: jest.fn(() => null),
    close: jest.fn(),
  })),
  createPromptHistoryStore: jest.fn(() => ({
    load: () => [],
    record: jest.fn(),
  })),
}));

jest.unstable_mockModule("../ui/processBashCommand.js", () => ({
  processBashCommand: mockProcessBashCommand,
}));

jest.unstable_mockModule("../ui/turnCancelListener.js", () => ({
  createTurnCancelListener: mockCreateTurnCancelListener,
}));

jest.unstable_mockModule("../ui/typeahead.js", () => ({
  createDefaultTypeaheadProviders: jest.fn(() => []),
  createSkillCommandTypeaheadProvider: jest.fn(() => ({})),
}));

const { runInteractiveSession } = await import("../index.js");

function createRuntimeConfig(
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  return {
    maxIterations: 50,
    maxRetries: 10,
    useNoProgressDetector: true,
    emptyToolOnlyStreakLimit: 3,
    bashDefaultTimeoutMs: 42_000,
    bashMaxTimeoutMs: 600_000,
    streamIdleTimeoutMs: 90_000,
    maxRecentTurns: 50,
    artifactInlineCharCap: 12_000,
    rehydrationMaxChars: 12_000,
    pinnedMemoryMaxContentLength: 2000,
    toolOutputInlineLimit: 1024,
    toolOutputPersistThreshold: 2048,
    aggregateToolResultsLimit: 512_000,
    toolResultSummaryMaxChars: 1500,
    artifactRetentionDays: 7,
    compactionFailureLimit: 3,
    outputTokenRecoveryLimit: 3,
    consecutive529FallbackLimit: 3,
    rollingSummaryTargetTokens: 2048,
    ...overrides,
  };
}

function createMockUi() {
  return {
    isJsonMode: () => false,
    getPromptOutputStream: () => process.stderr,
    command: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    setMode: jest.fn(),
    closeOverlay: jest.fn(),
    idleFooter: jest.fn(),
    setPromptState: jest.fn(),
    chatPrompt: () => "> ",
    bashPrompt: () => "! ",
  };
}

function createMockAgent() {
  return {
    streamChat: jest.fn(),
    listUserInvocableSkills: () => [],
    getConversationState: () => ({
      preamble: [],
      turns: [],
      artifacts: [],
      pinnedMemory: [],
      invokedSkills: [],
      rollingSummary: null,
    }),
  };
}

describe("runInteractiveSession bash routing", () => {
  const composeRequests: PromptRequest[] = [];
  let cancelOnAttach = false;

  beforeEach(() => {
    composeRequests.length = 0;
    cancelOnAttach = false;
    mockCompose.mockReset();
    mockProcessBashCommand.mockReset();
    mockCreateTurnCancelListener.mockReset();

    mockCompose.mockImplementation(async (request: PromptRequest) => {
      composeRequests.push({ ...request });

      if (composeRequests.length === 1) {
        return { status: "submitted", text: "pwd", inputMode: "bash" };
      }

      if (composeRequests.length === 2) {
        expect(request.inputMode).toBe("prompt");
        return { status: "closed" };
      }

      return { status: "closed" };
    });

    mockProcessBashCommand.mockResolvedValue(undefined);

    mockCreateTurnCancelListener.mockImplementation(({ onCancel }) => ({
      attach: () => {
        if (cancelOnAttach) {
          onCancel();
        }
      },
      detach: jest.fn(),
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function runBashRoutingSession(runtimeConfig = createRuntimeConfig()) {
    const agent = createMockAgent();
    const ui = createMockUi();
    const abortState = createAbortStateController(ui as never);

    await runInteractiveSession(
      agent as never,
      ui as never,
      "/tmp/providers.json",
      abortState,
      {
        showToolCalls: true,
        showThinking: true,
        showStatus: false,
        showReasoningSummary: false,
        showContextStats: false,
        showPromptPlan: false,
      },
      runtimeConfig,
    );

    return { agent, ui };
  }

  it("returns to prompt mode after a bash submission", async () => {
    const { agent } = await runBashRoutingSession();

    expect(composeRequests[1]?.inputMode).toBe("prompt");
    expect(mockProcessBashCommand).toHaveBeenCalledTimes(1);
    expect(agent.streamChat).not.toHaveBeenCalled();
  });

  it("routes /help through bash execution instead of slash handlers", async () => {
    mockCompose.mockReset();
    mockCompose
      .mockResolvedValueOnce({
        status: "submitted",
        text: "/help",
        inputMode: "bash",
      })
      .mockResolvedValueOnce({ status: "closed" });

    const { agent, ui } = await runBashRoutingSession();

    expect(mockProcessBashCommand).toHaveBeenCalledWith(
      "/help",
      ui,
      expect.objectContaining({ timeoutMs: 42_000, maxBuffer: 2048 }),
    );
    expect(agent.streamChat).not.toHaveBeenCalled();
  });

  it("accepts the next compose after Escape cancels a bash command", async () => {
    cancelOnAttach = true;
    mockCompose.mockReset();
    mockCompose
      .mockResolvedValueOnce({
        status: "submitted",
        text: "sleep 10",
        inputMode: "bash",
      })
      .mockResolvedValueOnce({ status: "closed" });

    await runBashRoutingSession(
      createRuntimeConfig({ bashDefaultTimeoutMs: 99_000 }),
    );

    expect(mockProcessBashCommand).toHaveBeenCalledTimes(1);
    expect(mockCompose).toHaveBeenCalledTimes(2);
    expect(mockCompose.mock.calls[1]?.[0]?.inputMode).toBe("prompt");
    expect(mockProcessBashCommand.mock.calls[0]?.[2]).toMatchObject({
      timeoutMs: 99_000,
      maxBuffer: 2048,
    });
  });
});
