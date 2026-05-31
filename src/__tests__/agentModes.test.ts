import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { Agent } from "../agent.js";
import { handleInteractiveSubmission } from "../index.js";
import { getIdleFooterText } from "../ui/slashCommands.js";
import { createAbortStateController } from "../ui/abortState.js";
import {
  createTtyInputStream,
  withKeypressEvents,
} from "../ui/__tests__/ttyTestStream.js";
import type { PromptComposer } from "../ui/promptComposer.js";
import { TerminalUi } from "../ui/terminal.js";
import {
  createTestAgent,
  createMockWriteStream,
  testProvidersConfig,
  userSubmission,
} from "./testHelpers.js";
import type {
  ChatRequest,
  ChatChunk,
  LLMProvider,
} from "../providers/types.js";
import { createMockTool } from "./testHelpers.js";
import { ToolRegistry } from "../tools/registry.js";
import { createPlainSubmission } from "../ui/input/promptSubmission.js";

describe("agent modes", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createPlanAgent(): Agent {
    const cwd = makeTempDir("agent-plan-cwd-");
    const homeDir = makeTempDir("agent-plan-home-");
    return new Agent({
      providersConfig: testProvidersConfig,
      cwd,
      homeDir,
    });
  }

  class SingleToolCallProvider implements LLMProvider {
    readonly name = "mock-single-tool";
    streamChatCalls: ChatRequest[] = [];

    constructor(
      private readonly toolName: string,
      private readonly toolArgs: Record<string, unknown>,
    ) {}

    getCapabilities() {
      return { contextWindowTokens: 128000 };
    }

    async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
      this.streamChatCalls.push(request);
      if (this.streamChatCalls.length === 1) {
        yield {
          delta: "",
          toolCalls: [
            {
              id: "call-1",
              function: {
                name: this.toolName,
                arguments: this.toolArgs,
              },
            },
          ],
        };
        return;
      }
      yield { delta: "Done." };
    }
  }

  async function runSlashCommand(agent: Agent, text: string): Promise<string> {
    const stdout = createMockWriteStream();
    const stderr = createMockWriteStream();
    const ui = new TerminalUi({
      interactive: true,
      plain: true,
      json: false,
      stdout,
      stderr,
    });
    const abortState = createAbortStateController(ui);
    await handleInteractiveSubmission(createPlainSubmission(text, "prompt"), {
      agent,
      ui,
      composer: {} as PromptComposer,
      configPath: "/tmp/providers.json",
      inputStream: withKeypressEvents(createTtyInputStream()),
      interactiveInput: true,
      setCurrentAbortController: abortState.setCurrentAbortController,
      cancelActiveTurn: abortState.cancelActiveTurn,
      shouldExit: abortState.shouldExit,
      getVisibility: () => ({
        showToolCalls: false,
        showThinking: false,
        showStatus: false,
        showReasoningSummary: false,
        showContextStats: false,
        showPromptPlan: false,
      }),
    });
    return [...stdout.chunks, ...stderr.chunks].join("\n");
  }

  it("does not create a plan file when entering plan mode", () => {
    const agent = createPlanAgent();
    agent.setAgentMode("plan");

    expect(agent.getPlanFilePath()).toBeUndefined();
    expect(agent.isPlanSaveApproved()).toBe(false);
  });

  it("does not create a plan file when cycling into plan mode", () => {
    const agent = createPlanAgent();
    agent.cycleAgentMode();

    expect(agent.getAgentMode()).toBe("plan");
    expect(agent.getPlanFilePath()).toBeUndefined();
  });

  it("hides write and skill tools in discover mode schemas and denies execution", async () => {
    const mockProvider = new SingleToolCallProvider("write", {
      path: "src/foo.ts",
      content: "x",
    });
    const agent = createTestAgent(mockProvider);
    agent.setAgentMode("discover");

    await agent.streamChat(userSubmission("Try to write"), () => {});

    const toolNames =
      mockProvider.streamChatCalls[0].tools?.map(
        (tool) => tool.function.name,
      ) ?? [];
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("edit");
    expect(toolNames).not.toContain("skill");
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("bash");

    const systemMsg = mockProvider.streamChatCalls[0].messages.find(
      (m) => m.role === "system",
    );
    expect(systemMsg?.content).toContain("Discover mode");
    expect(systemMsg?.content).not.toContain("<skills>");
  });

  it("uses the full mode reminder on the first plan/discover turn", async () => {
    class TextProvider implements LLMProvider {
      readonly name = "mock-text";
      streamChatCalls: ChatRequest[] = [];

      getCapabilities() {
        return { contextWindowTokens: 128000 };
      }

      async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
        this.streamChatCalls.push(request);
        yield { delta: "ok" };
      }
    }

    const mockProvider = new TextProvider();
    const agent = createTestAgent(mockProvider);
    agent.setAgentMode("discover");

    await agent.streamChat(userSubmission("Explore the repo"), () => {});

    const userMessages = mockProvider.streamChatCalls[0].messages.filter(
      (message) => message.role === "user",
    );
    const lastUser = userMessages.at(-1)?.content ?? "";
    expect(lastUser).toContain("[Mode reminder — Discover]");
    expect(lastUser).not.toContain("read-only exploration; no file edits");
  });

  it("omits write/edit in plan mode before approval", async () => {
    const mockProvider = new SingleToolCallProvider("write", {
      path: "src/foo.ts",
      content: "x",
    });
    const agent = createPlanAgent();
    (agent as any).provider = mockProvider;

    agent.setAgentMode("plan");
    expect(agent.getPlanFilePath()).toBeUndefined();

    await agent.streamChat(userSubmission("Write plan"), () => {});

    const toolNames =
      mockProvider.streamChatCalls[0].tools?.map(
        (tool) => tool.function.name,
      ) ?? [];
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("edit");
  });

  it("denies direct write calls in plan mode before approval", async () => {
    const mockProvider = new SingleToolCallProvider("write", {
      path: "src/foo.ts",
      content: "x",
    });
    const agent = createPlanAgent();
    (agent as any).provider = mockProvider;
    agent.setAgentMode("plan");

    await agent.streamChat(userSubmission("Write source"), () => {});

    const toolEntry = agent
      .getConversationState()
      .turns.at(-1)
      ?.entries.find((entry) => entry.kind === "tool");
    expect(toolEntry?.toolInvocations?.[0]?.status).toBe("error");
    expect(toolEntry?.toolInvocations?.[0]?.resultSummary).toContain(
      "Tool not available",
    );
  });

  it("allows plan-file write only after approved save", async () => {
    const agent = createPlanAgent();
    agent.setAgentMode("plan");
    const planPath = agent.saveApprovedPlan("# Approved plan\n");

    expect(fs.existsSync(planPath)).toBe(true);
    expect(agent.isPlanSaveApproved()).toBe(true);

    const mockProvider = new SingleToolCallProvider("write", {
      path: planPath,
      content: "# Updated plan\n",
    });
    (agent as any).provider = mockProvider;
    await agent.streamChat(userSubmission("Update plan file"), () => {});

    const toolNames =
      mockProvider.streamChatCalls[0].tools?.map(
        (tool) => tool.function.name,
      ) ?? [];
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("edit");

    const allowedEntry = agent
      .getConversationState()
      .turns.at(-1)
      ?.entries.find((entry) => entry.kind === "tool");
    expect(allowedEntry?.toolInvocations?.[0]?.status).toBe("success");

    const deniedProvider = new SingleToolCallProvider("write", {
      path: "src/foo.ts",
      content: "x",
    });
    (agent as any).provider = deniedProvider;
    await agent.streamChat(userSubmission("Write source"), () => {});

    const deniedEntry = agent
      .getConversationState()
      .turns.at(-1)
      ?.entries.find((entry) => entry.kind === "tool");
    expect(deniedEntry?.toolInvocations?.[0]?.status).toBe("error");
    expect(deniedEntry?.toolInvocations?.[0]?.resultSummary).toContain(
      "approved plan file",
    );
  });

  it("denies bash mutators in discover mode", async () => {
    const mockProvider = new SingleToolCallProvider("bash", {
      command: "rm -rf /tmp/x",
    });
    const agent = createTestAgent(mockProvider);
    agent.setAgentMode("discover");

    await agent.streamChat(userSubmission("Remove files"), () => {});

    const toolEntry = agent
      .getConversationState()
      .turns.at(-1)
      ?.entries.find((entry) => entry.kind === "tool");
    expect(toolEntry?.toolInvocations?.[0]?.status).toBe("error");
    expect(toolEntry?.toolInvocations?.[0]?.resultSummary).toContain(
      "not allowed",
    );
  });

  it("exports plan mode without planFilePath before approved save", () => {
    const agent = createPlanAgent();
    agent.setAgentMode("plan");

    const parsed = JSON.parse(agent.exportSession());
    expect(parsed.metadata.agentMode).toBe("plan");
    expect(parsed.metadata.planFilePath).toBeUndefined();
    expect(parsed.metadata.planSaveApproved).toBeUndefined();
  });

  it("exports and imports approved plan metadata in session v4", () => {
    const agent = createPlanAgent();
    agent.setAgentMode("plan");
    const planPath = agent.saveApprovedPlan("# Saved plan\n");

    const json = agent.exportSession();
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(4);
    expect(parsed.metadata.agentMode).toBe("plan");
    expect(parsed.metadata.planFilePath).toBe(planPath);
    expect(parsed.metadata.planSaveApproved).toBe(true);

    const imported = createPlanAgent();
    imported.importSession(json);
    expect(imported.getAgentMode()).toBe("plan");
    expect(imported.getPlanFilePath()).toBe(planPath);
    expect(imported.isPlanSaveApproved()).toBe(true);
  });

  it("excludes MCP tools from discover mode allowlist", async () => {
    const mockProvider = new SingleToolCallProvider("read", {
      path: "README.md",
    });
    const agent = createTestAgent(mockProvider);
    const registry = new ToolRegistry();
    registry.register(createMockTool({ name: "read" }), true);
    (agent as any).toolRegistry = registry;
    (agent as any).mcpManager = {
      getConnectedToolSchemas: () => [
        {
          type: "function",
          function: {
            name: "mcp_search",
            description: "search",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      hasTool: (name: string) => name === "mcp_search",
      executeToolWithStatus: async () => ({
        status: "success" as const,
        content: "mcp ok",
      }),
      describeToolInvocation: () => "mcp",
    };

    agent.setAgentMode("discover");
    await agent.streamChat(userSubmission("Search"), () => {});

    const toolNames =
      mockProvider.streamChatCalls[0].tools?.map(
        (tool) => tool.function.name,
      ) ?? [];
    expect(toolNames).not.toContain("mcp_search");
  });

  it("shows mode: plan in the footer without basename", () => {
    expect(
      getIdleFooterText({
        showToolCalls: true,
        showThinking: true,
        agentMode: "plan",
      }),
    ).toBe(
      "Enter to send | ? help | mode: plan | tools: shown | thinking: shown",
    );
  });

  it("does not print plan file paths from /mode commands", async () => {
    const agent = createPlanAgent();
    agent.setAgentMode("plan");
    agent.saveApprovedPlan("# Saved\n");

    const modeOutput = await runSlashCommand(agent, "/mode");
    expect(modeOutput).toContain("Current mode: plan");
    expect(modeOutput).not.toContain("Plan file:");

    const switchOutput = await runSlashCommand(agent, "/mode plan");
    expect(switchOutput).toContain("Switched to plan mode");
    expect(switchOutput).not.toContain("Plan file:");
  });

  it("saves an approved plan via /plan save and prints the full path once", async () => {
    const agent = createPlanAgent();
    agent.setAgentMode("plan");

    const output = await runSlashCommand(
      agent,
      "/plan save # Approved plan\n\nStep 1",
    );

    expect(output).toContain("Plan saved:");
    expect(agent.getPlanFilePath()).toBeDefined();
    expect(agent.isPlanSaveApproved()).toBe(true);
    expect(fs.existsSync(agent.getPlanFilePath()!)).toBe(true);
  });

  it("emits plan_saved once when saveApprovedPlan receives onEvent", () => {
    const agent = createPlanAgent();
    agent.setAgentMode("plan");

    let eventCount = 0;
    agent.saveApprovedPlan("# Plan\n", {
      onEvent: (event) => {
        if (event.type === "plan_saved") {
          eventCount += 1;
        }
      },
    });

    expect(eventCount).toBe(1);
  });
});
