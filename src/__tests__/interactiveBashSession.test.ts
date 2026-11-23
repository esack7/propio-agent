import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../agent.js";
import { testProvidersConfig, userSubmission } from "./testHelpers.js";
import { JsonlTraceJournal, RunTraceRecorder } from "../trace/index.js";
import { inspectSessionUsage } from "../cli/sessionInspection.js";
import { submittedPromptResult } from "../ui/__tests__/promptComposerTestHelpers.js";
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

const { processBashCommand: actualProcessBashCommand } =
  await import("../ui/processBashCommand.js");
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
    traceCaptureLevel: "standard",
    allowGlobalInstallsWithoutPrompt: false,
    ...overrides,
  };
}

function createMockUi() {
  return {
    isJsonMode: () => false,
    getPromptOutputStream: () => process.stderr,
    error: jest.fn(),
    status: jest.fn(),
    bashCommand: jest.fn(),
    bashOutput: jest.fn(),
    clearEphemeralSurfaces: jest.fn(),
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
    createOperatorShellTraceRun: jest.fn(() => ({
      recorder: {
        identity: { sessionId: "active", runId: "shell" },
        record: jest.fn(),
      },
      close: jest.fn(),
    })),
    streamChat: jest.fn(),
    listUserInvocableSkills: () => [],
    setApprovalChannel: jest.fn(),
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
        return submittedPromptResult("pwd", "bash");
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

  it("wires an actual credential-free shell command to the active agent journal", async () => {
    mockProcessBashCommand.mockImplementation(actualProcessBashCommand);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shell-wiring-"));
    try {
      const root = path.join(directory, "traces");
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        cwd: directory,
        homeDir: directory,
        mcpConfig: { mcpServers: {} },
        sessionsDir: directory,
        createTraceRun: (identity) => {
          const journal = new JsonlTraceJournal(
            path.join(root, identity.sessionId, `${identity.runId}.jsonl`),
          );
          return {
            recorder: new RunTraceRecorder(identity, journal),
            close: () => journal.close(),
          };
        },
      });
      Object.assign(agent, {
        provider: {
          name: "fixture",
          getCapabilities: () => ({ contextWindowTokens: 128000 }),
          async *streamChat() {
            yield { delta: "ok" };
          },
        },
      });
      await agent.streamChat(userSubmission("hello"), () => {});
      const foreground = agent.getSessionTraceIdentity();
      expect(foreground.runId).toBeDefined();
      const ui = createMockUi();
      await runInteractiveSession(
        agent,
        ui as never,
        "/tmp/providers.json",
        createAbortStateController(ui as never),
        {
          showToolCalls: true,
          showThinking: true,
          showStatus: false,
          showReasoningSummary: false,
          showContextStats: false,
          showPromptPlan: false,
        },
        createRuntimeConfig(),
      );
      expect(agent.getSessionTraceIdentity()).toEqual(foreground);
      const usage = inspectSessionUsage(root, foreground.sessionId);
      const shell = usage.runs.find((run) =>
        run.events.some((e) => e.type === "operator_shell_started"),
      );
      expect(shell?.complete).toBe(true);
      expect(shell?.events.at(-1)?.type).toBe("operator_shell_completed");
      expect(ui.bashOutput).toHaveBeenCalledWith(expect.any(String), "", 0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns to prompt mode after a bash submission", async () => {
    const { agent } = await runBashRoutingSession();

    expect(composeRequests[1]?.inputMode).toBe("prompt");
    expect(mockProcessBashCommand).toHaveBeenCalledTimes(1);
    expect(agent.streamChat).not.toHaveBeenCalled();
  });

  it("routes /help through bash execution instead of slash handlers", async () => {
    mockCompose.mockReset();
    mockCompose
      .mockResolvedValueOnce(submittedPromptResult("/help", "bash"))
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
      .mockResolvedValueOnce(submittedPromptResult("sleep 10", "bash"))
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
