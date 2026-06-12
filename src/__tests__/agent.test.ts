import * as path from "path";
import { userSubmission } from "./testHelpers.js";
import { createRequire } from "module";
import { Agent } from "../agent.js";
import { LLMProvider } from "@propio-ai/providers";
import {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ChatChunk,
  ChatMessage,
  ChatToolCall,
  ProviderContextLengthError,
} from "@propio-ai/providers";
import { ProvidersConfig } from "@propio-ai/providers";
import { ExecutableTool } from "../tools/interface.js";
import { AgentDiagnosticEvent } from "../diagnostics.js";
import type { AgentVisibilityEvent } from "../agent.js";
import {
  testProvidersConfig as sharedTestProvidersConfig,
  createTestAgent,
  createMockTool,
  ToolCallMockProvider,
  TEST_PNG_DATA_URL,
  userSubmissionWithImages,
  findUserMessageWithImages,
} from "./testHelpers.js";

const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
const os = require("os") as typeof import("os");

/**
 * Mock LLM Provider for testing
 */
class MockProvider implements LLMProvider {
  name = "mock";
  streamChatCalls: ChatRequest[] = [];

  getCapabilities() {
    return { contextWindowTokens: 128000 };
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    this.streamChatCalls.push(request);
    yield { delta: "Mock " };
    yield { delta: "response" };
  }
}

function createImmediateFailProvider(
  name: string,
  message: string,
): LLMProvider {
  return {
    name,
    getCapabilities: () => ({ contextWindowTokens: 128000 }),
    async *streamChat() {
      throw new Error(message);
    },
  };
}

function createFirstToolCallThenFailProvider(options: {
  name: string;
  toolCalls: ChatToolCall[];
  errorMessage: string;
  reasoningContent?: string;
}): LLMProvider {
  const requests: ChatRequest[] = [];
  return {
    name: options.name,
    getCapabilities: () => ({ contextWindowTokens: 128000 }),
    async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
      requests.push(request);
      if (requests.length === 1) {
        yield {
          type: "tool_calls",
          toolCalls: options.toolCalls,
          ...(options.reasoningContent
            ? { reasoningContent: options.reasoningContent }
            : {}),
        };
        return;
      }
      throw new Error(options.errorMessage);
    },
  };
}

const testProvidersConfig: ProvidersConfig = sharedTestProvidersConfig;

function writeSkillDocument(
  rootDir: string,
  skillName: string,
  frontmatter: string,
  body: string,
): string {
  const skillDir = path.join(rootDir, ".propio", "skills", skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillFile, `---\n${frontmatter}\n---\n\n${body}\n`);
  return skillFile;
}

async function withSpiedDirs<T>(
  cwdDir: string,
  homeDir: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(cwdDir);
  const homeSpy = jest.spyOn(os, "homedir").mockReturnValue(homeDir);
  try {
    return await fn();
  } finally {
    cwdSpy.mockRestore();
    homeSpy.mockRestore();
  }
}

/**
 * Creates fresh cwd and home directories for a skill test.
 * Any pre-existing directories are removed first.
 */
function createSkillDirs(
  cwdName: string,
  homeName: string,
  baseDir: string,
): { cwdDir: string; homeDir: string } {
  const cwdDir = path.join(baseDir, cwdName);
  const homeDir = path.join(baseDir, homeName);
  fs.rmSync(cwdDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.mkdirSync(cwdDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  return { cwdDir, homeDir };
}

describe("Agent with Multi-Provider Configuration", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-agent-tests-"));

  afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Shared base for mock providers that track streamChat calls and invocation
   * count. Subclasses provide a `name` and implement `streamChat`.
   */
  abstract class CountingMockProvider implements LLMProvider {
    abstract name: string;
    streamChatCalls: ChatRequest[] = [];
    callCount = 0;

    getCapabilities() {
      return { contextWindowTokens: 128000 };
    }

    abstract streamChat(request: ChatRequest): AsyncIterable<ChatChunk>;
  }

  /**
   * Creates a diagnostics-enabled agent (no provider injected) and returns
   * the mutable events array with the agent.
   */
  function createEventsAndAgent(): {
    events: AgentDiagnosticEvent[];
    agent: Agent;
  } {
    const events: AgentDiagnosticEvent[] = [];
    const agent = new Agent({
      providersConfig: testProvidersConfig,
      diagnosticsEnabled: true,
      onDiagnosticEvent: (event) => {
        events.push(event);
      },
    });
    return { events, agent };
  }

  /**
   * Creates a diagnostics-enabled agent with a fresh MockProvider injected,
   * and returns the collected events array alongside the agent and provider.
   */
  function createDiagnosticsAgent(): {
    diagnosticEvents: AgentDiagnosticEvent[];
    agent: Agent;
    mockProvider: MockProvider;
  } {
    const diagnosticEvents: AgentDiagnosticEvent[] = [];
    const agent = new Agent({
      providersConfig: testProvidersConfig,
      diagnosticsEnabled: true,
      onDiagnosticEvent: (event) => diagnosticEvents.push(event),
    });
    const mockProvider = new MockProvider();
    (agent as any).provider = mockProvider;
    return { diagnosticEvents, agent, mockProvider };
  }

  describe("Constructor with ProvidersConfig object", () => {
    it("should require providersConfig parameter", () => {
      expect(() => new Agent()).toThrow(/providersConfig|required/i);
    });

    it("should accept ProvidersConfig object", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect(agent).toBeDefined();
    });

    it("should accept ProvidersConfig with default provider", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect(agent).toBeDefined();
      expect((agent as any).provider).toBeDefined();
    });

    it("should accept optional providerName to override default", () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        providerName: "bedrock",
      });
      expect(agent).toBeDefined();
    });

    it("should accept optional modelKey to override defaultModel", () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        modelKey: "llama3.2:90b",
      });
      expect(agent).toBeDefined();
    });

    it("should load skills from explicit cwd and homeDir", () => {
      const cwdDir = path.join(tempDir, "explicit-cwd");
      const homeDir = path.join(tempDir, "explicit-home");

      fs.mkdirSync(cwdDir, { recursive: true });
      fs.mkdirSync(homeDir, { recursive: true });

      writeSkillDocument(
        cwdDir,
        "context-skill",
        "name: context-skill\ndescription: Context skill",
        "Context body.",
      );

      const agent = new Agent({
        providersConfig: testProvidersConfig,
        cwd: cwdDir,
        homeDir,
      });

      expect(agent.listSkills().map((skill) => skill.name)).toContain(
        "context-skill",
      );
    });

    it("should throw error if providerName does not exist", () => {
      expect(() => {
        new Agent({
          providersConfig: testProvidersConfig,
          providerName: "nonexistent",
        });
      }).toThrow(/unknown.*provider|not found/i);
    });

    it("should throw error if modelKey does not exist in provider", () => {
      expect(() => {
        new Agent({
          providersConfig: testProvidersConfig,
          modelKey: "nonexistent-model",
        });
      }).toThrow(/invalid.*model|not found|unknown model/i);
    });
  });

  describe("Constructor with file path", () => {
    it("should accept file path string as providersConfig", () => {
      const configPath = path.join(tempDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify(testProvidersConfig));

      const agent = new Agent({ providersConfig: configPath });
      expect(agent).toBeDefined();
    });

    it("should load config from file and use default provider", () => {
      const configPath = path.join(tempDir, "config-default.json");
      fs.writeFileSync(configPath, JSON.stringify(testProvidersConfig));

      const agent = new Agent({ providersConfig: configPath });
      expect(agent).toBeDefined();
    });

    it("should throw error if file does not exist", () => {
      const configPath = path.join(tempDir, "nonexistent.json");
      expect(() => {
        new Agent({ providersConfig: configPath });
      }).toThrow(/not found|ENOENT/i);
    });

    it("should throw error if file contains invalid JSON", () => {
      const configPath = path.join(tempDir, "invalid.json");
      fs.writeFileSync(configPath, "{ invalid }");

      expect(() => {
        new Agent({ providersConfig: configPath });
      }).toThrow(/JSON|parse|invalid/i);
    });
  });

  describe("File mentions", () => {
    function createMentionsWorkspace(workspaceName: string): string {
      const workspaceRoot = path.join(tempDir, workspaceName);
      fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceRoot, "src", "info.txt"),
        "alpha\nbeta\ngamma",
      );
      return workspaceRoot;
    }

    function createMentionsAgent(workspaceName: string): Agent {
      return new Agent({
        providersConfig: testProvidersConfig,
        cwd: createMentionsWorkspace(workspaceName),
      });
    }

    it("attaches mentioned files before the provider call", async () => {
      const agent = createMentionsAgent("mentions-workspace");
      const mockProvider = new MockProvider();
      (agent as any).provider = mockProvider;

      const tokens: string[] = [];
      await agent.streamChat(
        userSubmission("@src/info.txt summarize"),
        (token) => {
          tokens.push(token);
        },
      );

      expect(tokens.join("")).toContain("Mock response");
      expect(mockProvider.streamChatCalls).toHaveLength(1);
      const request = mockProvider.streamChatCalls[0];
      expect(request.messages.some((message) => message.role === "user")).toBe(
        true,
      );
      expect(
        request.messages.find((message) => message.role === "user")?.content,
      ).toBe("@src/info.txt summarize");

      const assistantMessage = request.messages.find(
        (message) => message.role === "assistant" && message.toolCalls?.length,
      );
      expect(assistantMessage?.toolCalls?.[0].function.name).toBe("read");

      const toolMessage = request.messages.find(
        (message) => message.role === "tool" && message.toolResults?.length,
      );
      expect(toolMessage?.toolResults?.[0].content).toContain("beta");
    });

    it("drops mention-only failed turns after provider errors", async () => {
      const agent = createMentionsAgent("mentions-failure-workspace");
      (agent as any).provider = createImmediateFailProvider(
        "failing-after-mentions",
        "provider failed after mentions",
      );

      await expect(
        agent.streamChat(userSubmission("@src/info.txt summarize"), () => {}),
      ).rejects.toThrow(/provider failed after mentions/i);

      expect(agent.getConversationState().turns).toHaveLength(0);
      expect(agent.getConversationState().artifacts).toHaveLength(0);
    });

    it("preserves real tool partial turns after provider errors", async () => {
      const provider = createFirstToolCallThenFailProvider({
        name: "failing-after-real-tool",
        toolCalls: [
          {
            id: "call-1",
            function: {
              name: "read",
              arguments: { path: "package.json" },
            },
          },
        ],
        errorMessage: "provider failed after real tool",
      });
      const agent = createTestAgent(provider);

      await expect(
        agent.streamChat(userSubmission("Inspect package"), () => {}),
      ).rejects.toThrow(/provider failed after real tool/i);

      expect(agent.getConversationState().turns).toHaveLength(1);
      expect(agent.getConversationState().turns[0].entries).toHaveLength(2);
      expect(agent.getConversationState().artifacts).toHaveLength(1);
    });
  });

  describe("Provider reasoning content", () => {
    it("carries reasoning content through same-turn tool-call loops", async () => {
      const requests: ChatRequest[] = [];
      const provider: LLMProvider = {
        name: "reasoning-tool",
        getCapabilities: () => ({ contextWindowTokens: 128000 }),
        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          requests.push(request);
          if (requests.length === 1) {
            yield {
              type: "tool_calls",
              reasoningContent: "I should inspect package metadata.",
              toolCalls: [
                {
                  id: "tc-1",
                  function: {
                    name: "read",
                    arguments: { path: "package.json" },
                  },
                },
              ],
            };
            return;
          }
          yield { type: "assistant_text", delta: "Done" };
        },
      };
      const agent = createTestAgent(provider);

      await agent.streamChat(userSubmission("Inspect package"), () => {});

      expect(requests).toHaveLength(2);
      const replayedAssistant = requests[1].messages.find(
        (message) => message.role === "assistant" && message.toolCalls?.length,
      );
      expect(replayedAssistant?.reasoningContent).toBe(
        "I should inspect package metadata.",
      );
    });
  });

  describe("Provider Resolution", () => {
    it("should use default provider when not specified", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      // Default is 'local-ollama'
      expect(agent).toBeDefined();
      expect((agent as any).provider).toBeDefined();
    });

    it("should use specified provider when providerName provided", () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        providerName: "bedrock",
      });
      expect(agent).toBeDefined();
    });

    it("should store providersConfig for runtime switching", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect((agent as any).providersConfig).toBeDefined();
      expect((agent as any).providersConfig).toEqual(testProvidersConfig);
    });
  });

  describe("Model Resolution", () => {
    it("should use defaultModel when modelKey not provided", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect((agent as any).model).toBe("llama3.2:3b");
    });

    it("should use specified modelKey when provided", () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        modelKey: "llama3.2:90b",
      });
      expect((agent as any).model).toBe("llama3.2:90b");
    });

    it("should validate modelKey belongs to provider", () => {
      const config: ProvidersConfig = {
        default: "ollama",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [
              { name: "Model A", key: "model-a", contextWindowTokens: 128_000 },
            ],
            defaultModel: "model-a",
          },
        ],
      };

      expect(() => {
        new Agent({
          providersConfig: config,
          modelKey: "nonexistent",
        });
      }).toThrow(/invalid.*model|not found/i);
    });
  });

  describe("switchProvider() method", () => {
    it("should accept providerName to switch providers", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      const originalProvider = (agent as any).provider;

      expect(() => {
        agent.switchProvider("bedrock");
      }).not.toThrow();

      const newProvider = (agent as any).provider;
      expect(newProvider).toBeDefined();
    });

    it("should accept optional modelKey to override provider defaultModel", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });

      expect(() => {
        agent.switchProvider("local-ollama", "llama3.2:90b");
      }).not.toThrow();

      expect((agent as any).model).toBe("llama3.2:90b");
    });

    it("should use provider defaultModel when modelKey not provided", () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        modelKey: "llama3.2:90b",
      });

      agent.switchProvider("bedrock");

      expect((agent as any).model).toBe(
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
      );
    });

    it("should preserve session context when switching provider", async () => {
      const mockProvider = new MockProvider();
      const agent = createTestAgent(mockProvider);

      await agent.streamChat(userSubmission("First message"), () => {});
      const contextBefore = agent.getContext();

      agent.switchProvider("bedrock");

      const contextAfter = agent.getContext();
      expect(contextAfter.length).toBe(contextBefore.length);
      expect(contextAfter).toEqual(contextBefore);
    });

    it("should throw error for invalid provider name", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });

      expect(() => {
        agent.switchProvider("nonexistent");
      }).toThrow(/unknown.*provider|not found/i);
    });

    it("should throw error for invalid modelKey in target provider", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });

      expect(() => {
        agent.switchProvider("bedrock", "invalid-model");
      }).toThrow(/invalid.*model|not found/i);
    });

    it("should not modify provider on validation error", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      const originalProvider = (agent as any).provider;

      try {
        agent.switchProvider("nonexistent");
      } catch (e) {
        // Expected to throw
      }

      expect((agent as any).provider).toBe(originalProvider);
    });

    it("should expose the active provider/model selection", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });

      expect(agent.getActiveModelSelection()).toEqual({
        providerName: "local-ollama",
        modelKey: "llama3.2:3b",
      });

      agent.switchProvider("local-ollama", "llama3.2:90b");

      expect(agent.getActiveModelSelection()).toEqual({
        providerName: "local-ollama",
        modelKey: "llama3.2:90b",
      });
    });
  });

  describe("skills bridge", () => {
    it("should list and refresh local skills without requiring invocation support", async () => {
      const { cwdDir, homeDir } = createSkillDirs("cwd", "home", tempDir);

      await withSpiedDirs(cwdDir, homeDir, () => {
        const agent = new Agent({
          providersConfig: testProvidersConfig,
          cwd: cwdDir,
          homeDir,
        });
        expect(agent.listSkills()).toEqual([]);
        expect(agent.refreshSkills()).toEqual([]);
      });
    });

    it("should surface an invoked skill body only once in the next prompt", async () => {
      const { cwdDir, homeDir } = createSkillDirs(
        "skill-prompt-cwd",
        "skill-prompt-home",
        tempDir,
      );

      writeSkillDocument(
        cwdDir,
        "review",
        "name: review\ndescription: Review skill",
        "Use the review skill body once.",
      );

      await withSpiedDirs(cwdDir, homeDir, async () => {
        const mockProvider = new MockProvider();
        const agent = createTestAgent(mockProvider);

        await agent.invokeSkill("review", "src/foo.ts", {
          source: "user",
        });
        await agent.streamChat(userSubmission("Inspect the file"), () => {});

        const promptText = mockProvider.streamChatCalls[0].messages
          .map((message) => message.content)
          .join("\n");
        const matches = promptText.match(/Use the review skill body once\./g);

        expect(matches).toHaveLength(1);
      });
    });

    it("should support an immediate skill turn with an empty user prompt", async () => {
      const { cwdDir, homeDir } = createSkillDirs(
        "skill-immediate-cwd",
        "skill-immediate-home",
        tempDir,
      );

      writeSkillDocument(
        cwdDir,
        "instant",
        "name: instant\ndescription: Instant skill",
        "Use the instant skill body once.",
      );

      await withSpiedDirs(cwdDir, homeDir, async () => {
        const mockProvider = new MockProvider();
        const agent = createTestAgent(mockProvider);

        await agent.invokeSkill("instant", undefined, { source: "user" });
        await agent.streamChat(userSubmission(""), () => {});

        expect(mockProvider.streamChatCalls).toHaveLength(1);
        const promptText = mockProvider.streamChatCalls[0].messages
          .map((message) => message.content)
          .join("\n");
        expect(promptText).toContain("Use the instant skill body once.");
      });
    });

    it("should not activate path skills from denied tool calls", async () => {
      const { cwdDir, homeDir } = createSkillDirs(
        "skill-path-cwd",
        "skill-path-home",
        tempDir,
      );

      writeSkillDocument(
        cwdDir,
        "scope-lock",
        [
          "name: scope-lock",
          "description: Scope lock skill",
          "allowed-tools:",
          "  - write",
        ].join("\n"),
        "This skill constrains tool access.",
      );
      writeSkillDocument(
        cwdDir,
        "path-activation",
        [
          "name: path-activation",
          "description: Path activation skill",
          "paths:",
          "  - src/**",
        ].join("\n"),
        "This skill should stay dormant when the read call is denied.",
      );

      class MockProviderWithDeniedRead implements LLMProvider {
        name = "mock-denied-read";
        streamChatCalls: ChatRequest[] = [];
        callCount = 0;

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
          this.streamChatCalls.push(request);
          this.callCount++;

          if (this.callCount === 1) {
            yield { delta: "Reading" };
            yield {
              delta: "",
              toolCalls: [
                {
                  id: "call-1",
                  function: {
                    name: "read",
                    arguments: { path: "src/app.ts" },
                  },
                },
              ],
            };
            return;
          }

          yield { delta: "Done" };
        }
      }

      await withSpiedDirs(cwdDir, homeDir, async () => {
        const agent = new Agent({ providersConfig: testProvidersConfig });
        await agent.invokeSkill("scope-lock", undefined, {
          source: "user",
        });

        const mockProvider = new MockProviderWithDeniedRead();
        (agent as any).provider = mockProvider;

        await agent.streamChat(userSubmission("Check the file"), () => {});

        const requestToolNames =
          mockProvider.streamChatCalls[0].tools?.map(
            (tool) => tool.function.name,
          ) ?? [];
        const activeSkillNames = agent
          .listUserInvocableSkills()
          .map((skill) => skill.name);

        expect(requestToolNames).toEqual(["write"]);
        expect(activeSkillNames).toContain("scope-lock");
        expect(activeSkillNames).not.toContain("path-activation");

        const systemMsg = mockProvider.streamChatCalls[0].messages.find(
          (m) => m.role === "system",
        );
        expect(systemMsg?.content).toContain("Enabled tools: write");
        expect(systemMsg?.content).not.toMatch(/\bEnabled tools:.*\bread\b/);
        expect(systemMsg?.content).not.toMatch(/\bEnabled tools:.*\bbash\b/);
      });
    });

    it("should record model and effort warnings when the current model differs", async () => {
      const { cwdDir, homeDir } = createSkillDirs(
        "skill-model-cwd",
        "skill-model-home",
        tempDir,
      );

      writeSkillDocument(
        cwdDir,
        "model-skill",
        [
          "name: model-skill",
          "description: Model skill",
          "model: claude-3.5-sonnet",
          "effort: high",
        ].join("\n"),
        "Model-sensitive body.",
      );

      await withSpiedDirs(cwdDir, homeDir, async () => {
        const agent = new Agent({ providersConfig: testProvidersConfig });
        await agent.invokeSkill("model-skill", undefined, {
          source: "user",
        });

        const invokedSkills = agent.getConversationState().invokedSkills ?? [];
        expect(invokedSkills).toHaveLength(1);
        expect(invokedSkills[0].scope.appliedModel).toBeUndefined();
        expect("appliedEffort" in invokedSkills[0].scope).toBe(false);
        expect(invokedSkills[0].scope.warnings ?? []).toEqual(
          expect.arrayContaining([
            expect.stringContaining(
              'Requested model "claude-3.5-sonnet" was not applied',
            ),
            expect.stringContaining(
              'Requested effort "high" was recorded but not applied',
            ),
          ]),
        );
      });
    });

    it("should record a matching model as applied", async () => {
      const { cwdDir, homeDir } = createSkillDirs(
        "skill-model-match-cwd",
        "skill-model-match-home",
        tempDir,
      );

      writeSkillDocument(
        cwdDir,
        "matching-model-skill",
        [
          "name: matching-model-skill",
          "description: Matching model skill",
          "model: llama3.2:3b",
          "effort: high",
        ].join("\n"),
        "Matching model body.",
      );

      await withSpiedDirs(cwdDir, homeDir, async () => {
        const agent = new Agent({ providersConfig: testProvidersConfig });
        await agent.invokeSkill("matching-model-skill", undefined, {
          source: "user",
        });

        const invokedSkills = agent.getConversationState().invokedSkills ?? [];
        expect(invokedSkills).toHaveLength(1);
        expect(invokedSkills[0].scope.appliedModel).toBe("llama3.2:3b");
        expect(invokedSkills[0].scope.warnings ?? []).toEqual(
          expect.arrayContaining([
            expect.stringContaining(
              'Requested effort "high" was recorded but not applied',
            ),
          ]),
        );
        expect(invokedSkills[0].scope.warnings ?? []).not.toEqual(
          expect.arrayContaining([expect.stringContaining("Requested model")]),
        );
      });
    });

    it("should warn when a skill body references an unknown placeholder", async () => {
      const { cwdDir, homeDir } = createSkillDirs(
        "skill-placeholder-cwd",
        "skill-placeholder-home",
        tempDir,
      );

      writeSkillDocument(
        cwdDir,
        "placeholder-skill",
        "name: placeholder-skill\ndescription: Placeholder skill",
        "Use $MISSING and $ARGUMENTS.",
      );

      await withSpiedDirs(cwdDir, homeDir, async () => {
        const agent = new Agent({ providersConfig: testProvidersConfig });
        expect(
          agent
            .getSkillDiagnostics()
            .some((item) => item.code === "unknown_placeholder"),
        ).toBe(false);
        await agent.invokeSkill("placeholder-skill", "alpha beta", {
          source: "user",
        });

        expect(
          agent
            .getSkillDiagnostics()
            .some((item) => item.code === "unknown_placeholder"),
        ).toBe(true);
        const invokedSkills = agent.getConversationState().invokedSkills ?? [];
        expect(invokedSkills).toHaveLength(1);
        expect(invokedSkills[0].content).toContain("$MISSING");
        expect(invokedSkills[0].scope.warnings ?? []).toEqual(
          expect.arrayContaining([
            expect.stringContaining('Unknown placeholder "$MISSING"'),
          ]),
        );
      });
    });
  });

  describe("Chat Integration with New Config", () => {
    it("should pass resolved model to provider in streamChat", async () => {
      const mockProvider = new MockProvider();
      const agent = createTestAgent(mockProvider);

      await agent.streamChat(userSubmission("Test"), () => {});

      expect(mockProvider.streamChatCalls[0].model).toBe("llama3.2:3b");
    });

    it("should pass correct model when modelKey override is used", async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        modelKey: "llama3.2:90b",
      });
      (agent as any).provider = mockProvider;

      await agent.streamChat(userSubmission("Test"), () => {});

      expect(mockProvider.streamChatCalls[0].model).toBe("llama3.2:90b");
    });

    it("should maintain all existing streamChat functionality", async () => {
      const mockProvider = new MockProvider();
      const agent = createTestAgent(mockProvider);

      const response = await agent.streamChat(
        userSubmission("Test message"),
        () => {},
      );

      expect(typeof response).toBe("string");
      expect(response).toBe("Mock response");
      expect(mockProvider.streamChatCalls).toHaveLength(1);
    });

    it("should support token-by-token streaming", async () => {
      const mockProvider = new MockProvider();
      const agent = createTestAgent(mockProvider);

      const tokens: string[] = [];
      const response = await agent.streamChat(userSubmission("Test"), (token) =>
        tokens.push(token),
      );

      expect(typeof response).toBe("string");
      expect(tokens.length).toBeGreaterThan(0);
    });
  });

  describe("Backward Compatibility", () => {
    it("should keep streamChat() signature unchanged", async () => {
      const mockProvider = new MockProvider();
      const agent = createTestAgent(mockProvider);

      const response = await agent.streamChat(userSubmission("Test"), () => {});
      expect(typeof response).toBe("string");
    });

    it("should keep context management methods unchanged", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect(typeof agent.clearContext).toBe("function");
      expect(typeof agent.getContext).toBe("function");
      expect(typeof agent.setSystemPrompt).toBe("function");
    });

    it("should keep tool management methods unchanged", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect(typeof agent.getTools).toBe("function");
    });
  });

  describe("Tool Introspection Methods", () => {
    it("should return all registered tool names via getToolNames()", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      const toolNames = agent.getToolNames();

      expect(Array.isArray(toolNames)).toBe(true);
      expect(toolNames.length).toBeGreaterThan(0);
      // Should contain known built-in tools
      expect(toolNames).toContain("read");
      expect(toolNames).toContain("write");
    });

    it("should return true for enabled tools via isToolEnabled()", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      // read and write are enabled by default
      expect(agent.isToolEnabled("read")).toBe(true);
      expect(agent.isToolEnabled("write")).toBe(true);
    });

    it("should return false for disabled tools via isToolEnabled()", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      // grep/find/ls are disabled by default
      expect(agent.isToolEnabled("grep")).toBe(false);
      expect(agent.isToolEnabled("find")).toBe(false);
      expect(agent.isToolEnabled("ls")).toBe(false);
    });

    it("should return false for nonexistent tools via isToolEnabled()", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect(agent.isToolEnabled("nonexistent_tool")).toBe(false);
    });

    it("should reflect tool state changes via isToolEnabled()", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });

      // Enable a disabled tool
      agent.enableTool("bash");
      expect(agent.isToolEnabled("bash")).toBe(true);

      // Disable an enabled tool
      agent.disableTool("read");
      expect(agent.isToolEnabled("read")).toBe(false);

      // Re-enable
      agent.enableTool("read");
      expect(agent.isToolEnabled("read")).toBe(true);
    });

    it("should expose read-only tool summaries and bulk state helpers", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      const summaries = agent.getToolSummaries();

      expect(summaries[0]).toMatchObject({
        name: "read",
        description: "Read a text file.",
        enabled: true,
        enabledByDefault: true,
      });

      agent.disableAllTools();
      expect(agent.getToolSummaries().every((tool) => !tool.enabled)).toBe(
        true,
      );

      agent.enableAllTools();
      expect(agent.getToolSummaries().every((tool) => tool.enabled)).toBe(true);

      agent.resetToolsToManifestDefaults();
      expect(agent.isToolEnabled("read")).toBe(true);
      expect(agent.isToolEnabled("grep")).toBe(false);
    });

    it("wires setGlobalInstallApprovalCallback into bash tool execution", async () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      const approval = jest.fn().mockResolvedValue(false);
      agent.setGlobalInstallApprovalCallback(approval);

      const result = await (agent as any).toolRegistry.executeWithStatus(
        "bash",
        {
          command: "npm install -g eslint",
        },
      );

      expect(approval).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "npm install -g eslint",
          reason: expect.stringMatching(/npm/i),
        }),
      );
      expect(result.status).toBe("error");
      expect(result.content).toMatch(/Global software install blocked/);
    });
  });

  function startEscapeAbortedChat(
    agent: Agent,
    message: string,
    delayBeforeAbortMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const chatPromise = agent.streamChat(userSubmission(message), () => {}, {
      abortSignal: controller.signal,
    });
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, delayBeforeAbortMs));
      controller.abort("escape");
    })();
    return chatPromise;
  }

  describe("streamChat with tool execution via onEvent", () => {
    /**
     * Mock Provider that yields tool calls and then a final response
     */
    class MockProviderWithToolCalls extends CountingMockProvider {
      name = "mock-tools";

      async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
        this.streamChatCalls.push(request);
        this.callCount++;

        if (this.callCount === 1) {
          // First call: provide tool call
          yield { delta: "I'll " };
          yield { delta: "execute " };
          yield { delta: "a " };
          yield { delta: "tool" };
          // Yield tool call with no function.arguments
          yield {
            delta: "",
            toolCalls: [
              {
                id: "call-1",
                function: {
                  name: "read",
                  arguments: { path: "package.json" },
                },
              },
            ],
          };
        } else {
          // Subsequent calls: return final response without tool calls
          yield { delta: "Done" };
        }
      }
    }

    it("should pass abortSignal to provider streamChat requests", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = createTestAgent(mockProvider);

      const controller = new AbortController();
      await agent.streamChat(userSubmission("Test"), jest.fn(), {
        abortSignal: controller.signal,
      });

      expect(mockProvider.streamChatCalls.length).toBeGreaterThan(0);
      expect(mockProvider.streamChatCalls[0].signal).toBe(controller.signal);
    });

    it("should reject immediately when abortSignal is already aborted", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = createTestAgent(mockProvider);

      const controller = new AbortController();
      controller.abort();

      await expect(
        agent.streamChat(userSubmission("Test"), jest.fn(), {
          abortSignal: controller.signal,
        }),
      ).rejects.toThrow("Request cancelled");
    });

    it("should not commit provider output when abort fires but the stream finishes normally", async () => {
      class IgnoreAbortProvider implements LLMProvider {
        name = "ignore-abort";

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(): AsyncIterable<ChatChunk> {
          await new Promise((resolve) => setTimeout(resolve, 100));
          yield { delta: "late output" };
        }
      }

      const agent = createTestAgent(new IgnoreAbortProvider());

      await expect(
        startEscapeAbortedChat(agent, "hello", 20),
      ).rejects.toThrow();
      expect(agent.getConversationState().turns).toHaveLength(0);
      expect(agent.getContext()).toEqual([]);
    });

    it("should stop awaiting a long-running tool when escape aborts", async () => {
      const slowTool = createMockTool({
        name: "slow_tool",
        description: "Slow tool for abort testing.",
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return "slow-done";
        },
      });

      const provider = new ToolCallMockProvider("slow_tool");
      const agent = createTestAgent(provider);
      agent.addTool(slowTool);

      const controller = new AbortController();
      const startedAt = Date.now();
      const chatPromise = agent.streamChat(
        userSubmission("run slow tool"),
        () => {},
        {
          abortSignal: controller.signal,
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort("escape");

      await expect(chatPromise).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(300);
    });

    it("should abandon a user-only turn when escape aborts before assistant output", async () => {
      class WaitingMockProvider extends CountingMockProvider {
        name = "mock-wait";

        async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
          this.streamChatCalls.push(request);
          await new Promise<void>((_resolve, reject) => {
            const rejectCancelled = () => {
              reject(new Error("Request cancelled"));
            };
            if (request.signal?.aborted) {
              rejectCancelled();
              return;
            }
            request.signal?.addEventListener("abort", rejectCancelled, {
              once: true,
            });
          });
        }
      }

      const mockProvider = new WaitingMockProvider();
      const agent = createTestAgent(mockProvider);

      await expect(
        startEscapeAbortedChat(agent, "Cancel me", 20),
      ).rejects.toThrow();
      expect(agent.getConversationState().turns).toHaveLength(0);
    });

    it("should still invoke deprecated onToolStart callback", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = createTestAgent(mockProvider);

      const onToolStart = jest.fn();

      await agent.streamChat(userSubmission("Test"), jest.fn(), {
        onToolStart,
      });

      expect(onToolStart).toHaveBeenCalledTimes(1);
      expect(onToolStart).toHaveBeenCalledWith("read");
    });

    it("should still invoke deprecated onToolEnd callback", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = createTestAgent(mockProvider);

      const onToolEnd = jest.fn();

      await agent.streamChat(userSubmission("Test"), jest.fn(), { onToolEnd });

      expect(onToolEnd).toHaveBeenCalledTimes(1);
      expect(onToolEnd).toHaveBeenCalledWith(
        "read",
        expect.any(String),
        "success",
      );
    });
  });

  describe("Tool result context limits", () => {
    class LargeResultTool implements ExecutableTool {
      readonly name = "large_result_tool";
      readonly description = "Return a very large output.";

      getSchema() {
        return {
          type: "function" as const,
          function: {
            name: "large_result_tool",
            description: "Returns a very large output",
            parameters: {
              type: "object",
              properties: {},
            },
          },
        };
      }

      async execute(): Promise<string> {
        return "x".repeat(13000);
      }
    }

    class MockProviderCapturingToolResult extends CountingMockProvider {
      name = "mock-capture";

      async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
        this.streamChatCalls.push(request);
        this.callCount++;

        if (this.callCount === 1) {
          yield {
            delta: "",
            toolCalls: [
              {
                id: "call-large",
                function: { name: "large_result_tool", arguments: {} },
              },
            ],
          };
          return;
        }

        yield { delta: "final" };
      }
    }

    it("should cap rehydrated oversized tool results in the follow-up provider request", async () => {
      const provider = new MockProviderCapturingToolResult();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      agent.addTool(new LargeResultTool());
      (agent as any).provider = provider;

      await agent.streamChat(userSubmission("run it"), () => {});

      expect(provider.streamChatCalls.length).toBe(2);
      const secondRequest = provider.streamChatCalls[1];
      const toolMessage = secondRequest.messages.find((m) => m.role === "tool");
      const toolContent = toolMessage?.toolResults?.[0]?.content ?? "";

      expect(toolContent.length).toBeLessThan(13000);
      expect(toolContent).toContain("[output truncated:");
    });
  });

  describe("LLM diagnostics", () => {
    it("should emit diagnostics for request lifecycle including empty responses", async () => {
      class EmptyResponseProvider implements LLMProvider {
        name = "empty-provider";

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(): AsyncIterable<ChatChunk> {
          yield { delta: "" };
        }
      }

      const { events, agent } = createEventsAndAgent();
      (agent as any).provider = new EmptyResponseProvider();

      const response = await agent.streamChat(
        userSubmission("hello"),
        () => {},
      );
      expect(response).toBe("");
      expect(events.some((event) => event.type === "request_started")).toBe(
        true,
      );
      expect(events.some((event) => event.type === "chunk_received")).toBe(
        true,
      );
      expect(events.some((event) => event.type === "iteration_finished")).toBe(
        true,
      );
      expect(events.some((event) => event.type === "empty_response")).toBe(
        true,
      );
    });

    it("should emit provider_error diagnostics on stream failures", async () => {
      class FailingProvider implements LLMProvider {
        name = "failing-provider";

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(): AsyncIterable<ChatChunk> {
          throw new Error("boom");
        }
      }

      const { events, agent } = createEventsAndAgent();
      (agent as any).provider = new FailingProvider();

      await expect(
        agent.streamChat(userSubmission("hello"), () => {}),
      ).rejects.toThrow(/boom|failing-provider/i);
      expect(
        events.some(
          (event) =>
            event.type === "provider_error" &&
            event.provider === "failing-provider",
        ),
      ).toBe(true);
    });

    type MaxIterationsDiagnostic = Extract<
      AgentDiagnosticEvent,
      { type: "max_iterations_reached" }
    >;

    const findMaxIterationsDiagnostic = (
      events: AgentDiagnosticEvent[],
    ): MaxIterationsDiagnostic | undefined =>
      events.find(
        (event): event is MaxIterationsDiagnostic =>
          event.type === "max_iterations_reached",
      );

    class VaryingTool implements ExecutableTool {
      readonly name = "varying_tool";
      readonly description = "No-op tool with changing arguments.";

      getSchema() {
        return {
          type: "function" as const,
          function: {
            name: "varying_tool",
            description: "No-op tool with changing arguments",
            parameters: {
              type: "object",
              properties: {
                index: { type: "number" },
              },
            },
          },
        };
      }

      async execute(): Promise<string> {
        return "ok";
      }
    }

    class RepeatingToolCallProvider implements LLMProvider {
      name = "repeating-tool-call-provider";
      streamChatCalls: ChatRequest[] = [];

      constructor(
        private readonly toolName: string,
        private readonly finalAnswerAfterFirstToolCall?: string,
      ) {}

      getCapabilities() {
        return { contextWindowTokens: 128000 };
      }

      async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
        this.streamChatCalls.push(request);
        if (
          this.finalAnswerAfterFirstToolCall &&
          this.streamChatCalls.length > 1
        ) {
          yield { delta: this.finalAnswerAfterFirstToolCall };
          return;
        }

        yield { delta: `Partial ${this.streamChatCalls.length}.` };
        yield {
          delta: "",
          toolCalls: [
            {
              id: `call-${this.streamChatCalls.length}`,
              function: {
                name: this.toolName,
                arguments: { index: this.streamChatCalls.length },
              },
            },
          ],
        };
      }
    }

    function expectMaxIterationsDiagnostic(
      events: AgentDiagnosticEvent[],
      failedToolCount: number,
      failedTools: string[],
    ) {
      const maxEvent = findMaxIterationsDiagnostic(events);
      expect(maxEvent).toBeDefined();
      expect(maxEvent?.iterationsCompleted).toBe(2);
      expect(maxEvent?.pendingToolCalls).toBe(1);
      expect(maxEvent?.failedToolCount).toBe(failedToolCount);
      expect(maxEvent?.failedTools).toEqual(failedTools);
    }

    function createDiagnosticAgentWithTool(
      provider: LLMProvider,
      tool: ExecutableTool,
    ): { agent: Agent; events: AgentDiagnosticEvent[] } {
      const events: AgentDiagnosticEvent[] = [];
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        diagnosticsEnabled: true,
        onDiagnosticEvent: (event) => {
          events.push(event);
        },
      });
      agent.addTool(tool);
      (agent as any).provider = provider;
      return { agent, events };
    }

    class RepeatedToolLoopProvider implements LLMProvider {
      streamChatCalls: ChatRequest[] = [];

      constructor(
        readonly name: string,
        private readonly options: {
          toolName: string;
          toolArgs: Record<string, unknown>;
          loopDelta: string;
          fallbackDelta: string;
        },
      ) {}

      getCapabilities() {
        return { contextWindowTokens: 128000 };
      }

      async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
        this.streamChatCalls.push(request);
        if (!request.tools || request.tools.length === 0) {
          yield { delta: this.options.fallbackDelta };
          return;
        }
        yield {
          delta: this.options.loopDelta,
          toolCalls: [
            {
              id: `call-${this.streamChatCalls.length}`,
              function: {
                name: this.options.toolName,
                arguments: this.options.toolArgs,
              },
            },
          ],
        };
      }
    }

    async function expectVaryingToolMaxIterationRejection(
      maxIterations: number,
    ): Promise<{
      events: AgentDiagnosticEvent[];
      provider: RepeatingToolCallProvider;
    }> {
      const provider = new RepeatingToolCallProvider("varying_tool");
      const { agent, events } = createDiagnosticAgentWithTool(
        provider,
        new VaryingTool(),
      );

      await expect(
        agent.streamChat(userSubmission("hello"), () => {}, {
          maxIterations,
        }),
      ).rejects.toThrow(
        "Stopped after reaching max iterations before a final assistant response. The last output may be incomplete.",
      );

      return { events, provider };
    }

    it("should break repeated empty tool-call loops with a no-tools fallback response", async () => {
      const loopTool = createMockTool({
        name: "loop_tool",
        description: "No-op loop tool for testing.",
        execute: async () => "loop-ok",
      });

      const provider = new RepeatedToolLoopProvider("looping-provider", {
        toolName: "loop_tool",
        toolArgs: {},
        loopDelta: "",
        fallbackDelta: "Final answer without tools.",
      });
      const { agent, events } = createDiagnosticAgentWithTool(
        provider,
        loopTool,
      );

      const response = await agent.streamChat(
        userSubmission("hello"),
        () => {},
      );
      expect(response).toBe("Final answer without tools.");
      expect(
        events.some(
          (event) =>
            event.type === "no_progress_detected" ||
            event.type === "tool_loop_detected",
        ),
      ).toBe(true);
      expect(provider.streamChatCalls).toHaveLength(4);
      const finalCall = provider.streamChatCalls[3];
      expect(finalCall.tools).toBeUndefined();
    });

    it("should break repeated assistant text plus identical tool-call loops with a no-tools fallback response", async () => {
      const bashTool = createMockTool({
        name: "bash",
        description: "Shell for testing.",
        execute: async () => "search-ok",
      });

      const provider = new RepeatedToolLoopProvider(
        "static-text-loop-provider",
        {
          toolName: "bash",
          toolArgs: { command: "rg auth" },
          loopDelta: "Searching the repo for authentication code.",
          fallbackDelta: "Final plan draft without more searches.",
        },
      );
      const { agent, events } = createDiagnosticAgentWithTool(
        provider,
        bashTool,
      );

      const response = await agent.streamChat(
        userSubmission("Plan auth refactor"),
        () => {},
      );

      expect(response).toBe("Final plan draft without more searches.");
      expect(
        events.some((event) => event.type === "no_progress_detected"),
      ).toBe(true);
      expect(provider.streamChatCalls).toHaveLength(4);
      expect(provider.streamChatCalls[3]?.tools).toBeUndefined();
    });

    it("should not trigger no-progress detection when assistant text or tool args differ across iterations", async () => {
      const { events, provider } =
        await expectVaryingToolMaxIterationRejection(4);

      expect(
        events.some((event) => event.type === "no_progress_detected"),
      ).toBe(false);
      expect(provider.streamChatCalls).toHaveLength(4);
    });

    it("should throw a clear error when loop fallback also returns empty", async () => {
      const loopTool2 = createMockTool({
        name: "loop_tool",
        description: "No-op loop tool for testing.",
        execute: async () => "loop-ok",
      });

      class EmptyLoopingProvider implements LLMProvider {
        name = "empty-looping-provider";

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
          if (!request.tools || request.tools.length === 0) {
            yield { delta: "" };
            return;
          }
          yield {
            delta: "",
            toolCalls: [
              {
                id: "loop-call",
                function: { name: "loop_tool", arguments: {} },
              },
            ],
          };
        }
      }

      const agent = new Agent({
        providersConfig: testProvidersConfig,
      });
      agent.addTool(loopTool2);
      (agent as any).provider = new EmptyLoopingProvider();

      await expect(
        agent.streamChat(userSubmission("hello"), () => {}),
      ).rejects.toThrow(/Stopped after .* no final assistant response\./);
    });

    it("should reject when max iterations are reached with partial text and pending tool calls", async () => {
      const { events } = await expectVaryingToolMaxIterationRejection(2);

      expectMaxIterationsDiagnostic(events, 0, []);
    });

    it("should include failed tool details when max iterations stop an incomplete turn", async () => {
      const { events, agent } = createEventsAndAgent();
      (agent as any).provider = new RepeatingToolCallProvider("missing_tool");

      await expect(
        agent.streamChat(userSubmission("hello"), () => {}, {
          maxIterations: 2,
        }),
      ).rejects.toThrow("Failed tools: missing_tool.");

      expectMaxIterationsDiagnostic(events, 2, ["missing_tool"]);
    });

    it("should still resolve when a failed tool is followed by a final answer", async () => {
      const events: AgentDiagnosticEvent[] = [];
      const provider = new RepeatingToolCallProvider(
        "missing_tool",
        "Recovered with a final answer.",
      );
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        diagnosticsEnabled: true,
        onDiagnosticEvent: (event) => {
          events.push(event);
        },
      });
      (agent as any).provider = provider;

      const response = await agent.streamChat(
        userSubmission("hello"),
        () => {},
      );

      expect(response).toBe("Recovered with a final answer.");
      expect(provider.streamChatCalls).toHaveLength(2);
      expect(
        events.some(
          (event) =>
            event.type === "tool_execution_finished" &&
            event.status === "tool_not_found",
        ),
      ).toBe(true);
      expect(
        events.some((event) => event.type === "max_iterations_reached"),
      ).toBe(false);
    });

    it("should emit context_snapshot and enriched request_started for normal request", async () => {
      const { events, agent } = createEventsAndAgent();
      const mockProvider = new MockProvider();
      (agent as any).provider = mockProvider;

      await agent.streamChat(userSubmission("hello"), () => {});

      const snapshot = events.find((e) => e.type === "context_snapshot");
      expect(snapshot).toBeDefined();
      expect(snapshot!.type).toBe("context_snapshot");
      if (snapshot!.type === "context_snapshot") {
        expect(snapshot!.messageCount).toBeGreaterThanOrEqual(0);
        expect(snapshot!.totalChars).toBeGreaterThanOrEqual(0);
        expect(snapshot!.estimatedTokens).toBeGreaterThanOrEqual(0);
      }

      const reqStarted = events.find((e) => e.type === "request_started");
      expect(reqStarted).toBeDefined();
      if (reqStarted!.type === "request_started") {
        expect(reqStarted!.promptMessageCount).toBeGreaterThan(0);
        expect(reqStarted!.promptChars).toBeGreaterThan(0);
        expect(reqStarted!.estimatedPromptTokens).toBeGreaterThan(0);
        expect(reqStarted!.reservedOutputTokens).toBe(2048);
      }
    });

    it("should emit enriched request_started for no-tools fallback request", async () => {
      class LoopTool implements ExecutableTool {
        readonly name = "loop_tool";
        readonly description = "No-op.";
        getSchema() {
          return {
            type: "function" as const,
            function: {
              name: "loop_tool",
              description: "No-op",
              parameters: { type: "object", properties: {} },
            },
          };
        }
        async execute(): Promise<string> {
          return "ok";
        }
      }

      class LoopingProvider implements LLMProvider {
        name = "looping-provider";

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
          if (!request.tools || request.tools.length === 0) {
            yield { delta: "Final answer." };
            return;
          }
          yield {
            delta: "",
            toolCalls: [
              {
                id: `call-${Date.now()}`,
                function: { name: "loop_tool", arguments: {} },
              },
            ],
          };
        }
      }

      const { events, agent } = createEventsAndAgent();
      agent.addTool(new LoopTool());
      (agent as any).provider = new LoopingProvider();

      await agent.streamChat(userSubmission("hello"), () => {});

      const reqStartedEvents = events.filter(
        (e) => e.type === "request_started",
      );
      expect(reqStartedEvents.length).toBeGreaterThanOrEqual(2);

      // The fallback request (last request_started) should have enabledTools: 0
      const fallbackReq = reqStartedEvents[reqStartedEvents.length - 1];
      if (fallbackReq.type === "request_started") {
        expect(fallbackReq.enabledTools).toBe(0);
        expect(fallbackReq.promptMessageCount).toBeGreaterThan(0);
        expect(fallbackReq.promptChars).toBeGreaterThan(0);
        expect(fallbackReq.estimatedPromptTokens).toBeGreaterThan(0);
        expect(fallbackReq.reservedOutputTokens).toBe(2048);
      }
    });

    it("should include structured status in tool_execution_finished diagnostics", async () => {
      class ToolCallProvider implements LLMProvider {
        name = "tool-status-provider";
        private callCount = 0;

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
          this.callCount++;
          if (this.callCount === 1) {
            yield {
              delta: "",
              toolCalls: [
                {
                  id: "c1",
                  function: {
                    name: "read",
                    arguments: { path: "package.json" },
                  },
                },
              ],
            };
            return;
          }
          yield { delta: "Done." };
        }
      }

      const events: AgentDiagnosticEvent[] = [];
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        diagnosticsEnabled: true,
        onDiagnosticEvent: (event) => events.push(event),
      });
      (agent as any).provider = new ToolCallProvider();

      await agent.streamChat(userSubmission("test"), () => {});

      const toolFinished = events.find(
        (e) => e.type === "tool_execution_finished",
      );
      expect(toolFinished).toBeDefined();
      if (toolFinished?.type === "tool_execution_finished") {
        expect(toolFinished.status).toBe("success");
      }
    });
  });

  describe("Constructor with agentsMdContent option", () => {
    it("should accept agentsMdContent parameter", () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        agentsMdContent: "Project instructions",
      });
      expect(agent).toBeDefined();
    });

    it("should place agentsMdContent in a dedicated section after core identity", () => {
      const agentsMdContent = "Project-specific instructions";
      const customPrompt = "Custom system prompt";
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        systemPrompt: customPrompt,
        agentsMdContent: agentsMdContent,
      });

      expect((agent as any).baseRules).toBe(customPrompt);
      expect((agent as any).agentsMdContent).toBe(agentsMdContent);
    });

    it("should store default core identity when systemPrompt not provided", () => {
      const agentsMdContent = "Project-specific instructions";
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        agentsMdContent: agentsMdContent,
      });

      expect((agent as any).agentsMdContent).toBe(agentsMdContent);
      expect((agent as any).baseRules).toContain(
        "You are a helpful AI coding assistant",
      );
    });

    it("should keep custom core when agentsMdContent is empty", () => {
      const customPrompt = "Custom system prompt";
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        systemPrompt: customPrompt,
        agentsMdContent: "",
      });

      expect((agent as any).baseRules).toBe(customPrompt);
    });

    it("should keep custom core when agentsMdContent is not provided", () => {
      const customPrompt = "Custom system prompt";
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        systemPrompt: customPrompt,
      });

      expect((agent as any).baseRules).toBe(customPrompt);
    });

    it("should use default core identity when agentsMdContent and systemPrompt are not provided", () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
      });

      expect((agent as any).baseRules).toContain(
        "You are a helpful AI coding assistant",
      );
    });

    it("should include agentsMdContent in messages sent to provider", async () => {
      const mockProvider = new MockProvider();
      const agentsMdContent = "Project instructions";
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        agentsMdContent: agentsMdContent,
      });
      (agent as any).provider = mockProvider;

      await agent.streamChat(userSubmission("Test message"), () => {});

      expect(mockProvider.streamChatCalls).toHaveLength(1);
      const messages = mockProvider.streamChatCalls[0].messages;
      const systemMessage = messages.find((m) => m.role === "system");
      expect(systemMessage).toBeDefined();
      expect(systemMessage?.content).toContain(agentsMdContent);
    });

    it("should compose agentsMdContent exactly once when CLI passes both systemPrompt and agentsMdContent", async () => {
      const mockProvider = new MockProvider();
      const agentsMdContent = "## Project Instructions\nDo X, Y, Z.";
      const defaultPrompt = "You are a helpful AI coding assistant.";
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        systemPrompt: defaultPrompt,
        agentsMdContent,
      });
      (agent as any).provider = mockProvider;

      await agent.streamChat(userSubmission("Test"), () => {});

      const messages = mockProvider.streamChatCalls[0].messages;
      const systemMessage = messages.find((m) => m.role === "system");
      expect(systemMessage).toBeDefined();
      const systemContent = systemMessage!.content;

      // AGENTS content appears exactly once (no double-prepend)
      const firstIdx = systemContent.indexOf(agentsMdContent);
      const secondIdx = systemContent.indexOf(agentsMdContent, firstIdx + 1);
      expect(firstIdx).toBeGreaterThanOrEqual(0);
      expect(secondIdx).toBe(-1);

      // Both parts are present in compiled sections
      expect(systemContent).toContain(agentsMdContent);
      expect(systemContent).toContain(defaultPrompt);
      expect(systemContent.indexOf("# Core Identity")).toBeLessThan(
        systemContent.indexOf("# Project Instructions"),
      );
    });
  });

  describe("Visibility events and reasoning summary", () => {
    it("should emit status/tool/reasoning visibility events when onEvent is provided", async () => {
      class VisibilityMockProvider implements LLMProvider {
        name = "visibility-mock";
        private callCount = 0;

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          this.callCount++;
          if (this.callCount === 1) {
            yield { type: "assistant_text", delta: "Working on it." };
            yield {
              type: "tool_calls",
              toolCalls: [
                {
                  id: "tool-1",
                  function: {
                    name: "read",
                    arguments: { path: "package.json" },
                  },
                },
              ],
            };
            return;
          }
          yield { type: "assistant_text", delta: "Done." };
        }
      }

      const mockProvider = new VisibilityMockProvider();
      const agent = createTestAgent(mockProvider);

      const eventTypes: string[] = [];
      const statuses: string[] = [];
      await agent.streamChat(userSubmission("Test visibility"), jest.fn(), {
        onEvent: (event) => {
          eventTypes.push(event.type);
          if (event.type === "status") {
            statuses.push(event.status);
          }
          if (event.type === "tool_started") {
            expect(event.activityLabel).toBe("Reading package.json");
          }
        },
      });

      expect(eventTypes).toContain("tool_started");
      expect(
        eventTypes.includes("tool_finished") ||
          eventTypes.includes("tool_failed"),
      ).toBe(true);
      expect(eventTypes).toContain("reasoning_summary");
      expect(statuses).toContain("Preparing request");
      expect(statuses).toContain("Tool call received");
    });

    it("forwards thinking deltas through visibility events without persisting them", async () => {
      class ThinkingMockProvider implements LLMProvider {
        name = "thinking-mock";

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          yield { type: "thinking_delta", delta: "Considering the answer." };
          yield { type: "assistant_text", delta: "Final answer." };
        }
      }

      const events: AgentVisibilityEvent[] = [];
      const agent = createTestAgent(new ThinkingMockProvider());

      const response = await agent.streamChat(
        userSubmission("Test thinking"),
        jest.fn(),
        {
          onEvent: (event) => {
            events.push(event);
          },
        },
      );

      expect(response).toBe("Final answer.");
      expect(events.some((event) => event.type === "thinking_delta")).toBe(
        true,
      );
      const contextText = agent
        .getContext()
        .map((message) => message.content)
        .join("\n");
      expect(contextText).not.toContain("Considering the answer.");
    });

    it("should fall back to a generic activity label for custom tools", async () => {
      class CustomTool implements ExecutableTool {
        readonly name = "custom_tool";
        readonly description = "Custom tool for testing.";

        getSchema() {
          return {
            type: "function" as const,
            function: {
              name: "custom_tool",
              description: "Custom tool for testing",
              parameters: {
                type: "object",
                properties: {},
              },
            },
          };
        }

        async execute(): Promise<string> {
          return "custom-result";
        }
      }

      class CustomToolProvider implements LLMProvider {
        name = "custom-tool-provider";
        private callCount = 0;

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          this.callCount++;
          if (this.callCount === 1) {
            yield {
              type: "tool_calls",
              toolCalls: [
                {
                  id: "tool-1",
                  function: {
                    name: "custom_tool",
                    arguments: {},
                  },
                },
              ],
            };
            return;
          }
          yield { type: "assistant_text", delta: "Done." };
        }
      }

      const events: AgentVisibilityEvent[] = [];
      const agent = new Agent({ providersConfig: testProvidersConfig });
      agent.addTool(new CustomTool());
      (agent as any).provider = new CustomToolProvider();

      await agent.streamChat(userSubmission("Use custom tool"), () => {}, {
        onEvent: (event) => {
          events.push(event);
        },
      });

      const started = events.find((event) => event.type === "tool_started");
      expect(started?.type).toBe("tool_started");
      if (started?.type === "tool_started") {
        expect(started.activityLabel).toBe("custom_tool");
      }
    });

    it("should store last turn reasoning summary separately from session context", async () => {
      class DirectAnswerProvider implements LLMProvider {
        name = "direct-answer";

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          yield {
            type: "reasoning_summary",
            summary: "Provider summary",
            source: "provider",
          };
          yield { type: "assistant_text", delta: "Final answer." };
        }
      }

      const mockProvider = new DirectAnswerProvider();
      const agent = createTestAgent(mockProvider);

      await agent.streamChat(userSubmission("Answer directly"), jest.fn());
      const reasoning = agent.getLastTurnReasoningSummary();

      expect(reasoning).toBeDefined();
      expect(reasoning?.summary.length).toBeGreaterThan(0);
      expect(reasoning?.source).toBe("agent");

      const context = agent.getContext();
      expect(
        context.some((message) => message.content.includes("Provider summary")),
      ).toBe(false);
    });
  });

  describe("ProviderContextLengthError retry", () => {
    it("should retry with a tighter prompt on ProviderContextLengthError and succeed", async () => {
      let callCount = 0;

      class ContextLengthRetryProvider implements LLMProvider {
        name = "retry-mock";

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          callCount++;
          if (callCount === 1) {
            throw new ProviderContextLengthError("prompt too long");
          }
          yield { type: "assistant_text", delta: "Recovered answer" };
        }
      }

      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = new ContextLengthRetryProvider();

      const tokens: string[] = [];
      const response = await agent.streamChat(userSubmission("Hello"), (t) =>
        tokens.push(t),
      );

      expect(response).toBe("Recovered answer");
      expect(callCount).toBe(2);
    });

    it("should escalate through retry levels up to level 3", async () => {
      let callCount = 0;

      class PersistentContextLengthProvider implements LLMProvider {
        name = "persistent-retry-mock";

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          callCount++;
          if (callCount <= 3) {
            throw new ProviderContextLengthError("still too long");
          }
          yield { type: "assistant_text", delta: "Finally" };
        }
      }

      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = new PersistentContextLengthProvider();

      const response = await agent.streamChat(
        userSubmission("Hello"),
        jest.fn(),
      );
      expect(response).toBe("Finally");
      expect(callCount).toBe(4);
    });

    it("should throw after exhausting all retry levels", async () => {
      class AlwaysContextLengthProvider implements LLMProvider {
        name = "always-fail";

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          throw new ProviderContextLengthError("always too long");
        }
      }

      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = new AlwaysContextLengthProvider();

      await expect(
        agent.streamChat(userSubmission("Hello"), jest.fn()),
      ).rejects.toThrow();
    });

    it("should not retry on non-context-length provider errors", async () => {
      let callCount = 0;

      class GenericErrorProvider implements LLMProvider {
        name = "generic-error";

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          callCount++;
          throw new Error("generic failure");
        }
      }

      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = new GenericErrorProvider();

      await expect(
        agent.streamChat(userSubmission("Hello"), jest.fn()),
      ).rejects.toThrow();
      expect(callCount).toBe(1);
    });

    it("should also retry in the no-tools fallback path", async () => {
      let noToolCallCount = 0;

      class NoToolsRetryProvider implements LLMProvider {
        name = "no-tools-retry";
        private mainCallCount = 0;

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          this.mainCallCount++;

          if (request.tools && request.tools.length > 0) {
            // Main path: always return empty tool calls to trigger streak
            yield {
              type: "tool_calls",
              toolCalls: [
                {
                  id: `tc-${this.mainCallCount}`,
                  function: { name: "unknown_tool", arguments: {} },
                },
              ],
            };
            return;
          }

          // No-tools fallback path
          noToolCallCount++;
          if (noToolCallCount === 1) {
            throw new ProviderContextLengthError("no-tools too long");
          }
          yield { type: "assistant_text", delta: "No-tools recovered" };
        }
      }

      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = new NoToolsRetryProvider();

      const response = await agent.streamChat(
        userSubmission("Trigger fallback"),
        jest.fn(),
      );
      expect(response).toBe("No-tools recovered");
      expect(noToolCallCount).toBe(2);
    });
  });

  describe("prompt_plan diagnostic event", () => {
    it("should emit prompt_plan event with plan metadata on each request", async () => {
      const { diagnosticEvents, agent } = createDiagnosticsAgent();

      await agent.streamChat(userSubmission("Hello"), jest.fn());

      const planEvents = diagnosticEvents.filter(
        (e) => e.type === "prompt_plan",
      );
      expect(planEvents.length).toBeGreaterThanOrEqual(1);

      const planEvent = planEvents[0] as Extract<
        AgentDiagnosticEvent,
        { type: "prompt_plan" }
      >;
      expect(planEvent.contextWindowTokens).toBeGreaterThan(0);
      expect(planEvent.availableInputBudget).toBeGreaterThan(0);
      expect(planEvent.estimatedPromptTokens).toBeGreaterThan(0);
      expect(planEvent.reservedOutputTokens).toBeGreaterThan(0);
      expect(planEvent.retryLevel).toBe(0);
      expect(typeof planEvent.includedTurnCount).toBe("number");
      expect(typeof planEvent.omittedTurnCount).toBe("number");
      expect(typeof planEvent.includedArtifactCount).toBe("number");
      expect(typeof planEvent.usedRollingSummary).toBe("boolean");
    });
  });

  describe("summary refresh diagnostics", () => {
    it("should measure summary prompt size before the summary provider call", async () => {
      const { diagnosticEvents, agent } = createDiagnosticsAgent();
      (agent as any).summaryPolicy = {
        rawRecentTurns: 0,
        refreshIntervalTurns: 999,
        summaryTargetTokens: 256,
        contextPressureThreshold: 2,
      };

      await agent.streamChat(userSubmission("First"), () => {});
      await agent.streamChat(userSubmission("Second"), () => {});
      await (agent as any).runSummaryRefresh("turn_cadence");

      const startEvent = diagnosticEvents.find(
        (event) => event.type === "summary_refresh_started",
      );

      expect(startEvent).toBeDefined();
      if (startEvent?.type === "summary_refresh_started") {
        expect(startEvent.promptMessageCount).toBe(2);
        expect(startEvent.promptChars).toBeGreaterThan(0);
        expect(startEvent.estimatedPromptTokens).toBeGreaterThan(0);
      }
    });
  });

  describe("Pinned memory wrapper methods", () => {
    let agent: Agent;

    beforeEach(() => {
      agent = new Agent({ providersConfig: testProvidersConfig });
    });

    function expectSinglePinnedRecord(id: string) {
      const records = agent.getPinnedMemory();
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(id);
      return records[0];
    }

    it("pinFact should add a retrievable active memory record", () => {
      const id = agent.pinFact({
        kind: "fact",
        content: "Node.js 20 is required",
        source: { origin: "user" },
      });

      expect(typeof id).toBe("string");
      const record = expectSinglePinnedRecord(id);
      expect(record.kind).toBe("fact");
      expect(record.content).toBe("Node.js 20 is required");
      expect(record.lifecycle).toBe("active");
    });

    it("addProjectConstraint should pin a project-scoped constraint", () => {
      const id = agent.addProjectConstraint(
        "Never commit secrets",
        { origin: "application" },
        "security policy",
      );

      const record = expectSinglePinnedRecord(id);
      expect(record.kind).toBe("constraint");
      expect(record.scope).toBe("project");
      expect(record.rationale).toBe("security policy");
    });

    it("updateMemory should supersede the old record and return a new one", () => {
      const oldId = agent.pinFact({
        kind: "decision",
        content: "Use Jest for tests",
        source: { origin: "user" },
      });

      const newId = agent.updateMemory(oldId, {
        content: "Use Vitest for tests",
        rationale: "faster execution",
      });

      expect(newId).not.toBe(oldId);

      const active = agent.getPinnedMemory();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(newId);
      expect(active[0].content).toBe("Use Vitest for tests");

      const all = agent.getPinnedMemory({ includeInactive: true });
      expect(all).toHaveLength(2);
      const superseded = all.find((r) => r.id === oldId);
      expect(superseded?.lifecycle).toBe("superseded");
      expect(superseded?.supersededById).toBe(newId);
    });

    it("unpinFact should remove a record from active memory", () => {
      const id = agent.pinFact({
        kind: "fact",
        content: "temporary fact",
        source: { origin: "user" },
      });

      agent.unpinFact(id, "no longer relevant");

      expect(agent.getPinnedMemory()).toHaveLength(0);

      const all = agent.getPinnedMemory({ includeInactive: true });
      expect(all).toHaveLength(1);
      expect(all[0].lifecycle).toBe("removed");
    });

    it("getPinnedMemory should default to active-only", () => {
      agent.pinFact({
        kind: "fact",
        content: "fact A",
        source: { origin: "user" },
      });
      const bId = agent.pinFact({
        kind: "fact",
        content: "fact B",
        source: { origin: "user" },
      });
      agent.unpinFact(bId);

      expect(agent.getPinnedMemory()).toHaveLength(1);
      expect(agent.getPinnedMemory({ includeInactive: true })).toHaveLength(2);
    });

    it("pinned memory should survive export/import and affect subsequent prompt plans", async () => {
      agent.pinFact({
        kind: "constraint",
        content: "Always use TypeScript strict mode",
        source: { origin: "application" },
      });

      const json = agent.exportSession();
      const agent2 = new Agent({ providersConfig: testProvidersConfig });
      agent2.importSession(json);

      const records = agent2.getPinnedMemory();
      expect(records).toHaveLength(1);
      expect(records[0].content).toBe("Always use TypeScript strict mode");

      const mockProvider = new MockProvider();
      (agent2 as any).provider = mockProvider;

      await agent2.streamChat(userSubmission("Test"), () => {});

      const systemMsg = mockProvider.streamChatCalls[0].messages.find(
        (m) => m.role === "system",
      );
      expect(systemMsg?.content).toContain("<pinned_memory>");
      expect(systemMsg?.content).toContain("Always use TypeScript strict mode");
    });

    it("clearContext should remove all pinned memory", () => {
      agent.pinFact({
        kind: "fact",
        content: "will be cleared",
        source: { origin: "user" },
      });

      agent.clearContext();

      expect(agent.getPinnedMemory()).toEqual([]);
      expect(agent.getPinnedMemory({ includeInactive: true })).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  // Phase 8: Context UX & Introspection
  // -------------------------------------------------------------------

  describe("getConversationState()", () => {
    it("should return empty state on a fresh agent", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      const state = agent.getConversationState();

      expect(state.turns).toHaveLength(0);
      expect(state.artifacts).toHaveLength(0);
      expect(state.pinnedMemory).toHaveLength(0);
      expect(state.rollingSummary).toBeUndefined();
    });

    it("should reflect structured turns after a conversation", async () => {
      const mockProvider = new MockProvider();
      const agent = createTestAgent(mockProvider);

      await agent.streamChat(userSubmission("Hello"), () => {});

      const state = agent.getConversationState();
      expect(state.turns).toHaveLength(1);
      expect(state.turns[0].userMessage.content).toBe("Hello");
      expect(state.turns[0].completedAt).toBeDefined();
      expect(state.turns[0].entries.length).toBeGreaterThan(0);
    });
  });

  describe("getLastPromptPlan()", () => {
    it("should return null before any requests are made", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect(agent.getLastPromptPlan()).toBeNull();
    });

    it("should capture prompt plan after normal request flow", async () => {
      const mockProvider = new MockProvider();
      const agent = createTestAgent(mockProvider);

      await agent.streamChat(userSubmission("Test"), () => {});

      const snapshot = agent.getLastPromptPlan();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.provider).toBe("mock");
      expect(snapshot!.model).toBe("llama3.2:3b");
      expect(snapshot!.iteration).toBe(1);
      expect(snapshot!.contextWindowTokens).toBe(128000);
      expect(snapshot!.plan.messages.length).toBeGreaterThan(0);
      expect(snapshot!.plan.retryLevel).toBe(0);
      expect(snapshot!.plan.reservedOutputTokens).toBeGreaterThan(0);
      expect(snapshot!.availableInputBudget).toBe(
        snapshot!.contextWindowTokens - snapshot!.plan.reservedOutputTokens,
      );
    });

    it("should update after context-length retry flow", async () => {
      let callCount = 0;

      class RetryMockProvider implements LLMProvider {
        name = "retry-mock";
        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }
        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          callCount++;
          if (callCount === 1) {
            throw new ProviderContextLengthError("too long");
          }
          yield { type: "assistant_text" as const, delta: "Recovered" };
        }
      }

      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = new RetryMockProvider();

      await agent.streamChat(userSubmission("Trigger retry"), () => {});

      const snapshot = agent.getLastPromptPlan();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.plan.retryLevel).toBeGreaterThanOrEqual(1);
    });

    it("should update after no-tools fallback flow", async () => {
      let callCount = 0;

      class ToolLoopProvider implements LLMProvider {
        name = "tool-loop";
        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }
        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          callCount++;
          if (callCount <= 3) {
            yield {
              type: "tool_calls" as const,
              toolCalls: [
                {
                  id: `tc-${callCount}`,
                  function: {
                    name: "read",
                    arguments: { path: "package.json" },
                  },
                },
              ],
            };
          } else {
            yield { type: "assistant_text" as const, delta: "Final" };
          }
        }
      }

      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = new ToolLoopProvider();

      await agent.streamChat(userSubmission("Loop test"), () => {});

      const snapshot = agent.getLastPromptPlan();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.plan.messages.length).toBeGreaterThan(0);
    });

    it("should be a deep defensive copy", async () => {
      const mockProvider = new MockProvider();
      const agent = createTestAgent(mockProvider);

      await agent.streamChat(userSubmission("Test"), () => {});

      const snap1 = agent.getLastPromptPlan();
      const snap2 = agent.getLastPromptPlan();
      expect(snap1).not.toBe(snap2);
      expect(snap1!.plan).not.toBe(snap2!.plan);
      expect(snap1!.plan.messages).not.toBe(snap2!.plan.messages);
      expect(snap1!.plan.includedTurnIds).not.toBe(snap2!.plan.includedTurnIds);
      expect(snap1).toEqual(snap2);
    });

    it("should be null after clearContext()", async () => {
      const mockProvider = new MockProvider();
      const agent = createTestAgent(mockProvider);

      await agent.streamChat(userSubmission("Build a plan"), () => {});
      expect(agent.getLastPromptPlan()).not.toBeNull();

      agent.clearContext();
      expect(agent.getLastPromptPlan()).toBeNull();
    });

    it("should be null after importSession()", async () => {
      const mockProvider = new MockProvider();
      const agent = createTestAgent(mockProvider);

      await agent.streamChat(userSubmission("First session"), () => {});
      expect(agent.getLastPromptPlan()).not.toBeNull();

      const exported = agent.exportSession();
      agent.importSession(exported);
      expect(agent.getLastPromptPlan()).toBeNull();
    });

    it("should emit prompt_plan_built events for each iteration via onEvent", async () => {
      let callCount = 0;

      class ToolThenAnswerProvider implements LLMProvider {
        name = "multi-iter";
        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }
        async *streamChat(
          request: ChatRequest,
        ): AsyncIterable<ChatStreamEvent> {
          callCount++;
          if (callCount === 1) {
            yield {
              type: "tool_calls" as const,
              toolCalls: [
                {
                  id: "tc-1",
                  function: {
                    name: "read",
                    arguments: { path: "package.json" },
                  },
                },
              ],
            };
          } else {
            yield { type: "assistant_text" as const, delta: "Done" };
          }
        }
      }

      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = new ToolThenAnswerProvider();

      const planEvents: Array<{ iteration: number; retryLevel: number }> = [];
      await agent.streamChat(userSubmission("Multi iter"), () => {}, {
        onEvent: (event) => {
          if (event.type === "prompt_plan_built") {
            planEvents.push({
              iteration: event.snapshot.iteration,
              retryLevel: event.snapshot.plan.retryLevel,
            });
          }
        },
      });

      expect(planEvents.length).toBeGreaterThanOrEqual(2);
      expect(planEvents[0].iteration).toBe(1);
      expect(planEvents[1].iteration).toBe(2);
    });
  });

  describe("Tool visibility event rendering path", () => {
    class SingleToolCallProvider implements LLMProvider {
      name = "ui-path-mock";
      private callCount = 0;
      readonly toolName: string;
      readonly toolArguments: Record<string, unknown>;

      constructor(toolName: string, toolArguments: Record<string, unknown>) {
        this.toolName = toolName;
        this.toolArguments = toolArguments;
      }

      getCapabilities() {
        return { contextWindowTokens: 128000 };
      }

      async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
        this.callCount++;
        if (this.callCount === 1) {
          yield {
            delta: "",
            toolCalls: [
              {
                id: "tc-1",
                function: {
                  name: this.toolName,
                  arguments: this.toolArguments,
                },
              },
            ],
          };
          return;
        }
        yield { delta: "Done." };
      }
    }

    function collectEvents(
      agent: Agent,
      userMessage: string,
    ): Promise<AgentVisibilityEvent[]> {
      const events: AgentVisibilityEvent[] = [];
      return agent
        .streamChat(userSubmission(userMessage), () => {}, {
          onEvent: (event) => events.push(event),
        })
        .then(() => events);
    }

    function expectSingleToolEvent(
      events: AgentVisibilityEvent[],
      type: "tool_finished" | "tool_failed",
      toolName: string,
    ) {
      const matching = events.filter((event) => event.type === type);
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({ type, toolName });
    }

    it("emits tool_finished for a working tool", async () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = new SingleToolCallProvider("read", {
        path: "package.json",
      });

      const events = await collectEvents(agent, "list files");

      expectSingleToolEvent(events, "tool_finished", "read");
    });

    it("emits tool_failed for a disabled tool", async () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      agent.disableTool("grep");
      (agent as any).provider = new SingleToolCallProvider("grep", {
        path: ".",
        pattern: "needle",
      });

      const events = await collectEvents(agent, "list files");

      expectSingleToolEvent(events, "tool_failed", "grep");
    });

    it("emits tool_failed for a missing tool", async () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = new SingleToolCallProvider(
        "nonexistent_tool_xyz",
        {},
      );

      const events = await collectEvents(agent, "run tool");

      expectSingleToolEvent(events, "tool_failed", "nonexistent_tool_xyz");
    });
  });

  describe("PromptSubmission images → provider", () => {
    function expectUserMessageWithTestImage(
      messages: ChatMessage[],
      expectedContentFragment: string,
    ): void {
      const userMsg = findUserMessageWithImages(messages);
      expect(userMsg).toBeDefined();
      expect(userMsg!.images).toHaveLength(1);
      expect(userMsg!.images![0]).toBe(TEST_PNG_DATA_URL);
      expect(userMsg!.content).toContain(expectedContentFragment);
      expect(userMsg!.content).not.toMatch(/data:image\//);
    }

    it("should pass caption and image attachment on the first provider request", async () => {
      const mockProvider = new MockProvider();
      const agent = createTestAgent(mockProvider);

      await agent.streamChat(
        userSubmissionWithImages("describe this [Attached image: photo.png]", [
          TEST_PNG_DATA_URL,
        ]),
        () => {},
      );

      expect(mockProvider.streamChatCalls).toHaveLength(1);
      expectUserMessageWithTestImage(
        mockProvider.streamChatCalls[0].messages,
        "describe this",
      );
      expect(
        mockProvider.streamChatCalls[0].messages.find((m) => m.role === "user")!
          .content,
      ).toContain("[Attached image: photo.png]");
    });

    it("should pass image-only marker text with images on the first provider request", async () => {
      const mockProvider = new MockProvider();
      const agent = createTestAgent(mockProvider);

      await agent.streamChat(
        userSubmissionWithImages("[Attached image: photo.png]", [
          TEST_PNG_DATA_URL,
        ]),
        () => {},
      );

      expect(mockProvider.streamChatCalls).toHaveLength(1);
      const userMsg = findUserMessageWithImages(
        mockProvider.streamChatCalls[0].messages,
      );
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe("[Attached image: photo.png]");
      expect(userMsg!.images![0]).toBe(TEST_PNG_DATA_URL);
    });

    it("should retain user message images on the second provider request after a tool call", async () => {
      class MockProviderWithToolCalls extends CountingMockProvider {
        name = "mock-tools-images";

        async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
          this.streamChatCalls.push(request);
          this.callCount++;

          if (this.callCount === 1) {
            yield {
              delta: "",
              toolCalls: [
                {
                  id: "call-1",
                  function: {
                    name: "read",
                    arguments: { path: "package.json" },
                  },
                },
              ],
            };
          } else {
            yield { delta: "Done" };
          }
        }
      }

      const mockProvider = new MockProviderWithToolCalls();
      const agent = createTestAgent(mockProvider);

      await agent.streamChat(
        userSubmissionWithImages("see [Attached image: photo.png]", [
          TEST_PNG_DATA_URL,
        ]),
        jest.fn(),
      );

      expect(mockProvider.streamChatCalls.length).toBeGreaterThanOrEqual(2);
      const withImages = mockProvider.streamChatCalls[1].messages.filter(
        (m) => m.role === "user" && (m.images?.length ?? 0) > 0,
      );
      expect(withImages.length).toBeGreaterThanOrEqual(1);
      expect(withImages.some((m) => m.images![0] === TEST_PNG_DATA_URL)).toBe(
        true,
      );
    });
  });
});
