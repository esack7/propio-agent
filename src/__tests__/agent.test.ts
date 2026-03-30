import * as fs from "fs";
import * as path from "path";
import { Agent } from "../agent.js";
import { LLMProvider } from "../providers/interface.js";
import {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ChatChunk,
  ChatMessage,
  ProviderContextLengthError,
} from "../providers/types.js";
import { ProvidersConfig } from "../providers/config.js";
import { ExecutableTool } from "../tools/interface.js";
import type { ToolExecutionStatus } from "../tools/types.js";
import { AgentDiagnosticEvent } from "../diagnostics.js";

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

// Test providers config
const testProvidersConfig: ProvidersConfig = {
  default: "local-ollama",
  providers: [
    {
      name: "local-ollama",
      type: "ollama",
      models: [
        { name: "Llama 3.2 3B", key: "llama3.2:3b" },
        { name: "Llama 3.2 90B", key: "llama3.2:90b" },
      ],
      defaultModel: "llama3.2:3b",
      host: "http://localhost:11434",
    },
    {
      name: "bedrock",
      type: "bedrock",
      models: [
        {
          name: "Claude 3.5 Sonnet",
          key: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        },
      ],
      defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      region: "us-west-2",
    },
  ],
};

describe("Agent with Multi-Provider Configuration", () => {
  const tempDir = "/tmp/agent-tests";

  beforeAll(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

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
            models: [{ name: "Model A", key: "model-a" }],
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
        (agent as any).switchProvider("bedrock");
      }).not.toThrow();

      const newProvider = (agent as any).provider;
      expect(newProvider).toBeDefined();
    });

    it("should accept optional modelKey to override provider defaultModel", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });

      expect(() => {
        (agent as any).switchProvider("local-ollama", "llama3.2:90b");
      }).not.toThrow();

      expect((agent as any).model).toBe("llama3.2:90b");
    });

    it("should use provider defaultModel when modelKey not provided", () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        modelKey: "llama3.2:90b",
      });

      (agent as any).switchProvider("bedrock");

      expect((agent as any).model).toBe(
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
      );
    });

    it("should preserve session context when switching provider", async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("First message", () => {});
      const contextBefore = agent.getContext();

      (agent as any).switchProvider("bedrock");

      const contextAfter = agent.getContext();
      expect(contextAfter.length).toBe(contextBefore.length);
      expect(contextAfter).toEqual(contextBefore);
    });

    it("should throw error for invalid provider name", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });

      expect(() => {
        (agent as any).switchProvider("nonexistent");
      }).toThrow(/unknown.*provider|not found/i);
    });

    it("should throw error for invalid modelKey in target provider", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });

      expect(() => {
        (agent as any).switchProvider("bedrock", "invalid-model");
      }).toThrow(/invalid.*model|not found/i);
    });

    it("should not modify provider on validation error", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      const originalProvider = (agent as any).provider;

      try {
        (agent as any).switchProvider("nonexistent");
      } catch (e) {
        // Expected to throw
      }

      expect((agent as any).provider).toBe(originalProvider);
    });
  });

  describe("Chat Integration with New Config", () => {
    it("should pass resolved model to provider in streamChat", async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Test", () => {});

      expect(mockProvider.streamChatCalls[0].model).toBe("llama3.2:3b");
    });

    it("should pass correct model when modelKey override is used", async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        modelKey: "llama3.2:90b",
      });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Test", () => {});

      expect(mockProvider.streamChatCalls[0].model).toBe("llama3.2:90b");
    });

    it("should maintain all existing streamChat functionality", async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const response = await agent.streamChat("Test message", () => {});

      expect(typeof response).toBe("string");
      expect(response).toBe("Mock response");
      expect(mockProvider.streamChatCalls).toHaveLength(1);
    });
  });

  describe("Stream Integration with New Config", () => {
    it("should pass resolved model to provider in streamChat", async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Test", () => {});

      expect(mockProvider.streamChatCalls[0].model).toBe("llama3.2:3b");
    });

    it("should maintain all existing streamChat functionality", async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const tokens: string[] = [];
      const response = await agent.streamChat("Test", (token) =>
        tokens.push(token),
      );

      expect(typeof response).toBe("string");
      expect(tokens.length).toBeGreaterThan(0);
    });
  });

  describe("Backward Compatibility", () => {
    it("should keep streamChat() signature unchanged", async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const response = await agent.streamChat("Test", () => {});
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
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_file");
    });

    it("should return true for enabled tools via isToolEnabled()", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      // read_file is enabled by default
      expect(agent.isToolEnabled("read_file")).toBe(true);
      expect(agent.isToolEnabled("write_file")).toBe(true);
    });

    it("should return false for disabled tools via isToolEnabled()", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      // run_bash and remove are disabled by default
      expect(agent.isToolEnabled("run_bash")).toBe(false);
      expect(agent.isToolEnabled("remove")).toBe(false);
    });

    it("should return false for nonexistent tools via isToolEnabled()", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect(agent.isToolEnabled("nonexistent_tool")).toBe(false);
    });

    it("should reflect tool state changes via isToolEnabled()", () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });

      // Enable a disabled tool
      agent.enableTool("run_bash");
      expect(agent.isToolEnabled("run_bash")).toBe(true);

      // Disable an enabled tool
      agent.disableTool("read_file");
      expect(agent.isToolEnabled("read_file")).toBe(false);

      // Re-enable
      agent.enableTool("read_file");
      expect(agent.isToolEnabled("read_file")).toBe(true);
    });
  });

  describe("streamChat with Tool Lifecycle Callbacks", () => {
    /**
     * Mock Provider that yields tool calls and then a final response
     */
    class MockProviderWithToolCalls implements LLMProvider {
      name = "mock-tools";
      streamChatCalls: ChatRequest[] = [];
      callCount = 0;

      getCapabilities() {
        return { contextWindowTokens: 128000 };
      }

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
                  name: "list_dir",
                  arguments: { path: "." },
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

    it("should invoke onToolStart callback when tool execution begins (if provided)", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const onToolStart = jest.fn();
      const onToken = jest.fn();

      await agent.streamChat("Test", onToken, { onToolStart });

      expect(onToolStart).toHaveBeenCalledWith("list_dir");
      expect(onToolStart).toHaveBeenCalledTimes(1);
    });

    it("should invoke onToolEnd callback when tool execution completes (if provided)", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const onToolEnd = jest.fn();
      const onToken = jest.fn();

      await agent.streamChat("Test", onToken, { onToolEnd });

      expect(onToolEnd).toHaveBeenCalled();
      expect(onToolEnd).toHaveBeenCalledWith(
        "list_dir",
        expect.any(String),
        "success",
      );
      expect(onToolEnd).toHaveBeenCalledTimes(1);
    });

    it("should invoke both onToolStart and onToolEnd callbacks", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const onToolStart = jest.fn();
      const onToolEnd = jest.fn();
      const onToken = jest.fn();

      await agent.streamChat("Test", onToken, {
        onToolStart,
        onToolEnd,
      });

      expect(onToolStart).toHaveBeenCalledWith("list_dir");
      expect(onToolStart).toHaveBeenCalledTimes(1);
      expect(onToolEnd).toHaveBeenCalledWith(
        "list_dir",
        expect.any(String),
        "success",
      );
      expect(onToolEnd).toHaveBeenCalledTimes(1);
    });

    it("should suppress bracketed tool status messages when both callbacks are provided", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const onToolStart = jest.fn();
      const onToolEnd = jest.fn();
      const onToken = jest.fn();

      await agent.streamChat("Test", onToken, {
        onToolStart,
        onToolEnd,
      });

      // Check that bracketed tool messages were not sent to onToken
      const toolMessageCalls = onToken.mock.calls
        .map((call) => call[0])
        .filter(
          (token) =>
            token.includes("[Executing tool:") ||
            token.includes("[Tool result:"),
        );
      expect(toolMessageCalls).toHaveLength(0);
    });

    it("should use onToken for tool status when callbacks are not provided (backward compatible)", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const onToken = jest.fn();

      await agent.streamChat("Test", onToken);

      // Should have bracketed tool messages
      const toolMessageCalls = onToken.mock.calls
        .map((call) => call[0])
        .filter(
          (token) =>
            token.includes("[Executing tool:") ||
            token.includes("[Tool result:"),
        );
      expect(toolMessageCalls.length).toBeGreaterThan(0);
    });

    it("should use onToken for tool results when only onToolStart is provided", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const onToolStart = jest.fn();
      const onToken = jest.fn();

      await agent.streamChat("Test", onToken, { onToolStart });

      // Should NOT have [Executing tool:] message (handled by callback)
      const executingMessages = onToken.mock.calls
        .map((call) => call[0])
        .filter((token) => token.includes("[Executing tool:"));
      expect(executingMessages).toHaveLength(0);

      // Should HAVE [Tool result:] message (no callback for onToolEnd)
      const resultMessages = onToken.mock.calls
        .map((call) => call[0])
        .filter((token) => token.includes("[Tool result:"));
      expect(resultMessages.length).toBeGreaterThan(0);
    });

    it("should use onToken for tool execution start when only onToolEnd is provided", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const onToolEnd = jest.fn();
      const onToken = jest.fn();

      await agent.streamChat("Test", onToken, { onToolEnd });

      // Should HAVE [Executing tool:] message (no callback for onToolStart)
      const executingMessages = onToken.mock.calls
        .map((call) => call[0])
        .filter((token) => token.includes("[Executing tool:"));
      expect(executingMessages.length).toBeGreaterThan(0);

      // Should NOT have [Tool result:] message (handled by callback)
      const resultMessages = onToken.mock.calls
        .map((call) => call[0])
        .filter((token) => token.includes("[Tool result:"));
      expect(resultMessages).toHaveLength(0);
    });

    it("should invoke tool callbacks correctly for multiple tool executions", async () => {
      /**
       * Mock Provider that yields multiple tool calls and then a final response
       */
      class MockProviderWithMultipleTools implements LLMProvider {
        name = "mock-multi-tools";
        streamChatCalls: ChatRequest[] = [];
        callCount = 0;

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
          this.streamChatCalls.push(request);
          this.callCount++;

          if (this.callCount === 1) {
            // First call: provide multiple tool calls
            yield { delta: "Testing" };
            yield {
              delta: "",
              toolCalls: [
                {
                  id: "call-1",
                  function: {
                    name: "tool_one",
                    arguments: {},
                  },
                },
                {
                  id: "call-2",
                  function: {
                    name: "tool_two",
                    arguments: {},
                  },
                },
              ],
            };
          } else {
            // Subsequent calls: return final response
            yield { delta: "Finished" };
          }
        }
      }

      const mockProvider = new MockProviderWithMultipleTools();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const onToolStart = jest.fn();
      const onToolEnd = jest.fn();
      const onToken = jest.fn();

      await agent.streamChat("Test", onToken, {
        onToolStart,
        onToolEnd,
      });

      // Should be called for each tool
      expect(onToolStart).toHaveBeenCalledTimes(2);
      expect(onToolStart).toHaveBeenNthCalledWith(1, "tool_one");
      expect(onToolStart).toHaveBeenNthCalledWith(2, "tool_two");

      expect(onToolEnd).toHaveBeenCalledTimes(2);
      expect(onToolEnd).toHaveBeenNthCalledWith(
        1,
        "tool_one",
        expect.any(String),
        "tool_not_found",
      );
      expect(onToolEnd).toHaveBeenNthCalledWith(
        2,
        "tool_two",
        expect.any(String),
        "tool_not_found",
      );
    });

    it("should pass correct tool result string to onToolEnd callback", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const onToolEnd = jest.fn();
      const onToken = jest.fn();

      await agent.streamChat("Test", onToken, { onToolEnd });

      expect(onToolEnd).toHaveBeenCalled();
      const callArgs = onToolEnd.mock.calls[0];
      const result = callArgs[1];
      const status = callArgs[2] as ToolExecutionStatus;

      // Result should be a string
      expect(typeof result).toBe("string");
      // Result should not be empty
      expect(result.length).toBeGreaterThan(0);
      expect(status).toBe("success");
    });

    it("should pass 'tool_disabled' status in onToolEnd when tool is disabled", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;
      agent.disableTool("list_dir");

      const onToolEnd = jest.fn();
      const onToken = jest.fn();

      await agent.streamChat("Test", onToken, { onToolEnd });

      expect(onToolEnd).toHaveBeenCalledTimes(1);
      expect(onToolEnd).toHaveBeenCalledWith(
        "list_dir",
        expect.stringContaining("not available"),
        "tool_disabled",
      );
    });

    it("should pass 'tool_not_found' status in onToolEnd when tool does not exist", async () => {
      class MockProviderUnknownTool implements LLMProvider {
        name = "mock-unknown-tool";
        streamChatCalls: ChatRequest[] = [];
        callCount = 0;

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
          this.streamChatCalls.push(request);
          this.callCount++;

          if (this.callCount === 1) {
            yield {
              delta: "",
              toolCalls: [
                {
                  id: "call-unknown",
                  function: {
                    name: "nonexistent_tool_xyz",
                    arguments: {},
                  },
                },
              ],
            };
          } else {
            yield { delta: "Done" };
          }
        }
      }

      const mockProvider = new MockProviderUnknownTool();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const onToolEnd = jest.fn();
      const onToken = jest.fn();

      await agent.streamChat("Test", onToken, { onToolEnd });

      expect(onToolEnd).toHaveBeenCalledTimes(1);
      expect(onToolEnd).toHaveBeenCalledWith(
        "nonexistent_tool_xyz",
        expect.any(String),
        "tool_not_found",
      );
    });

    it("should pass abortSignal to provider streamChat requests", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const controller = new AbortController();
      await agent.streamChat("Test", jest.fn(), {
        abortSignal: controller.signal,
      });

      expect(mockProvider.streamChatCalls.length).toBeGreaterThan(0);
      expect(mockProvider.streamChatCalls[0].signal).toBe(controller.signal);
    });

    it("should reject immediately when abortSignal is already aborted", async () => {
      const mockProvider = new MockProviderWithToolCalls();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const controller = new AbortController();
      controller.abort();

      await expect(
        agent.streamChat("Test", jest.fn(), {
          abortSignal: controller.signal,
        }),
      ).rejects.toThrow("Request cancelled");
    });
  });

  describe("Tool result context limits", () => {
    class LargeResultTool implements ExecutableTool {
      readonly name = "large_result_tool";

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

    class MockProviderCapturingToolResult implements LLMProvider {
      name = "mock-capture";
      streamChatCalls: ChatRequest[] = [];
      callCount = 0;

      getCapabilities() {
        return { contextWindowTokens: 128000 };
      }

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

      await agent.streamChat("run it", () => {});

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

      const events: AgentDiagnosticEvent[] = [];
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        diagnosticsEnabled: true,
        onDiagnosticEvent: (event) => {
          events.push(event);
        },
      });
      (agent as any).provider = new EmptyResponseProvider();

      const response = await agent.streamChat("hello", () => {});
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

      const events: AgentDiagnosticEvent[] = [];
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        diagnosticsEnabled: true,
        onDiagnosticEvent: (event) => {
          events.push(event);
        },
      });
      (agent as any).provider = new FailingProvider();

      await expect(agent.streamChat("hello", () => {})).rejects.toThrow(
        /boom|failing-provider/i,
      );
      expect(
        events.some(
          (event) =>
            event.type === "provider_error" &&
            event.provider === "failing-provider",
        ),
      ).toBe(true);
    });

    it("should break repeated empty tool-call loops with a no-tools fallback response", async () => {
      class LoopTool implements ExecutableTool {
        readonly name = "loop_tool";

        getSchema() {
          return {
            type: "function" as const,
            function: {
              name: "loop_tool",
              description: "No-op loop tool for testing",
              parameters: {
                type: "object",
                properties: {},
              },
            },
          };
        }

        async execute(): Promise<string> {
          return "loop-ok";
        }
      }

      class LoopingProvider implements LLMProvider {
        name = "looping-provider";
        streamChatCalls: ChatRequest[] = [];

        getCapabilities() {
          return { contextWindowTokens: 128000 };
        }

        async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
          this.streamChatCalls.push(request);
          if (!request.tools || request.tools.length === 0) {
            yield { delta: "Final answer without tools." };
            return;
          }
          yield {
            delta: "",
            toolCalls: [
              {
                id: `call-${this.streamChatCalls.length}`,
                function: { name: "loop_tool", arguments: {} },
              },
            ],
          };
        }
      }

      const events: AgentDiagnosticEvent[] = [];
      const provider = new LoopingProvider();
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        diagnosticsEnabled: true,
        onDiagnosticEvent: (event) => {
          events.push(event);
        },
      });
      agent.addTool(new LoopTool());
      (agent as any).provider = provider;

      const response = await agent.streamChat("hello", () => {});
      expect(response).toBe("Final answer without tools.");
      expect(events.some((event) => event.type === "tool_loop_detected")).toBe(
        true,
      );
      expect(provider.streamChatCalls).toHaveLength(4);
      const finalCall = provider.streamChatCalls[3];
      expect(finalCall.tools).toBeUndefined();
    });

    it("should throw a clear error when loop fallback also returns empty", async () => {
      class LoopTool implements ExecutableTool {
        readonly name = "loop_tool";

        getSchema() {
          return {
            type: "function" as const,
            function: {
              name: "loop_tool",
              description: "No-op loop tool for testing",
              parameters: {
                type: "object",
                properties: {},
              },
            },
          };
        }

        async execute(): Promise<string> {
          return "loop-ok";
        }
      }

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
      agent.addTool(new LoopTool());
      (agent as any).provider = new EmptyLoopingProvider();

      await expect(agent.streamChat("hello", () => {})).rejects.toThrow(
        "Stopped after repeated empty tool-calling turns with no final assistant response.",
      );
    });

    it("should emit context_snapshot and enriched request_started for normal request", async () => {
      const events: AgentDiagnosticEvent[] = [];
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        diagnosticsEnabled: true,
        onDiagnosticEvent: (event) => {
          events.push(event);
        },
      });
      const mockProvider = new MockProvider();
      (agent as any).provider = mockProvider;

      await agent.streamChat("hello", () => {});

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

      const events: AgentDiagnosticEvent[] = [];
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        diagnosticsEnabled: true,
        onDiagnosticEvent: (event) => {
          events.push(event);
        },
      });
      agent.addTool(new LoopTool());
      (agent as any).provider = new LoopingProvider();

      await agent.streamChat("hello", () => {});

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
                  function: { name: "list_dir", arguments: { path: "." } },
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

      await agent.streamChat("test", () => {});

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

    it("should prepend agentsMdContent to system prompt when provided", () => {
      const agentsMdContent = "Project-specific instructions";
      const customPrompt = "Custom system prompt";
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        systemPrompt: customPrompt,
        agentsMdContent: agentsMdContent,
      });

      const systemPrompt = (agent as any).systemPrompt;
      expect(systemPrompt).toContain(agentsMdContent);
      expect(systemPrompt).toContain(customPrompt);
      expect(systemPrompt).toBe(`${agentsMdContent}\n\n${customPrompt}`);
    });

    it("should prepend agentsMdContent to default prompt when systemPrompt not provided", () => {
      const agentsMdContent = "Project-specific instructions";
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        agentsMdContent: agentsMdContent,
      });

      const systemPrompt = (agent as any).systemPrompt;
      expect(systemPrompt).toContain(agentsMdContent);
      expect(systemPrompt).toContain("You are a helpful AI assistant.");
      expect(systemPrompt.startsWith(agentsMdContent)).toBe(true);
    });

    it("should use system prompt unchanged when agentsMdContent is empty", () => {
      const customPrompt = "Custom system prompt";
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        systemPrompt: customPrompt,
        agentsMdContent: "",
      });

      const systemPrompt = (agent as any).systemPrompt;
      expect(systemPrompt).toBe(customPrompt);
    });

    it("should use system prompt unchanged when agentsMdContent is not provided", () => {
      const customPrompt = "Custom system prompt";
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        systemPrompt: customPrompt,
      });

      const systemPrompt = (agent as any).systemPrompt;
      expect(systemPrompt).toBe(customPrompt);
    });

    it("should use default prompt unchanged when agentsMdContent is not provided and systemPrompt is not provided", () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
      });

      const systemPrompt = (agent as any).systemPrompt;
      expect(systemPrompt).toBe("You are a helpful AI assistant.");
    });

    it("should include agentsMdContent in messages sent to provider", async () => {
      const mockProvider = new MockProvider();
      const agentsMdContent = "Project instructions";
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        agentsMdContent: agentsMdContent,
      });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Test message", () => {});

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

      await agent.streamChat("Test", () => {});

      const messages = mockProvider.streamChatCalls[0].messages;
      const systemMessage = messages.find((m) => m.role === "system");
      expect(systemMessage).toBeDefined();
      const systemContent = systemMessage!.content;

      // AGENTS content appears exactly once (no double-prepend)
      const firstIdx = systemContent.indexOf(agentsMdContent);
      const secondIdx = systemContent.indexOf(agentsMdContent, firstIdx + 1);
      expect(firstIdx).toBeGreaterThanOrEqual(0);
      expect(secondIdx).toBe(-1);

      // Both parts are present
      expect(systemContent).toContain(agentsMdContent);
      expect(systemContent).toContain(defaultPrompt);
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
                    name: "list_directory",
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

      const mockProvider = new VisibilityMockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const eventTypes: string[] = [];
      const statuses: string[] = [];
      await agent.streamChat("Test visibility", jest.fn(), {
        onEvent: (event) => {
          eventTypes.push(event.type);
          if (event.type === "status") {
            statuses.push(event.status);
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
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Answer directly", jest.fn());
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
      const response = await agent.streamChat("Hello", (t) => tokens.push(t));

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

      const response = await agent.streamChat("Hello", jest.fn());
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

      await expect(agent.streamChat("Hello", jest.fn())).rejects.toThrow();
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

      await expect(agent.streamChat("Hello", jest.fn())).rejects.toThrow();
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

      const response = await agent.streamChat("Trigger fallback", jest.fn());
      expect(response).toBe("No-tools recovered");
      expect(noToolCallCount).toBe(2);
    });
  });

  describe("prompt_plan diagnostic event", () => {
    it("should emit prompt_plan event with plan metadata on each request", async () => {
      const diagnosticEvents: AgentDiagnosticEvent[] = [];
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        diagnosticsEnabled: true,
        onDiagnosticEvent: (event) => diagnosticEvents.push(event),
      });
      const mockProvider = new MockProvider();
      (agent as any).provider = mockProvider;

      await agent.streamChat("Hello", jest.fn());

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
      const diagnosticEvents: AgentDiagnosticEvent[] = [];
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        diagnosticsEnabled: true,
        onDiagnosticEvent: (event) => diagnosticEvents.push(event),
      });
      const mockProvider = new MockProvider();
      (agent as any).provider = mockProvider;
      (agent as any).summaryPolicy = {
        rawRecentTurns: 0,
        refreshIntervalTurns: 999,
        summaryTargetTokens: 256,
        contextPressureThreshold: 2,
      };

      await agent.streamChat("First", () => {});
      await agent.streamChat("Second", () => {});
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

    it("pinFact should add a retrievable active memory record", () => {
      const id = agent.pinFact({
        kind: "fact",
        content: "Node.js 20 is required",
        source: { origin: "user" },
      });

      expect(typeof id).toBe("string");
      const records = agent.getPinnedMemory();
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(id);
      expect(records[0].kind).toBe("fact");
      expect(records[0].content).toBe("Node.js 20 is required");
      expect(records[0].lifecycle).toBe("active");
    });

    it("addProjectConstraint should pin a project-scoped constraint", () => {
      const id = agent.addProjectConstraint(
        "Never commit secrets",
        { origin: "application" },
        "security policy",
      );

      const records = agent.getPinnedMemory();
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(id);
      expect(records[0].kind).toBe("constraint");
      expect(records[0].scope).toBe("project");
      expect(records[0].rationale).toBe("security policy");
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

      await agent2.streamChat("Test", () => {});

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
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Hello", () => {});

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
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Test", () => {});

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

      await agent.streamChat("Trigger retry", () => {});

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
                  function: { name: "list_directory", arguments: {} },
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

      await agent.streamChat("Loop test", () => {});

      const snapshot = agent.getLastPromptPlan();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.plan.messages.length).toBeGreaterThan(0);
    });

    it("should be a deep defensive copy", async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Test", () => {});

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
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Build a plan", () => {});
      expect(agent.getLastPromptPlan()).not.toBeNull();

      agent.clearContext();
      expect(agent.getLastPromptPlan()).toBeNull();
    });

    it("should be null after importSession()", async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("First session", () => {});
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
                  function: { name: "list_directory", arguments: {} },
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
      await agent.streamChat("Multi iter", () => {}, {
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

  describe("Default (non-show-activity) UI rendering path", () => {
    class SingleToolCallProvider implements LLMProvider {
      name = "ui-path-mock";
      private callCount = 0;
      readonly toolName: string;

      constructor(toolName: string) {
        this.toolName = toolName;
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
                function: { name: this.toolName, arguments: { path: "." } },
              },
            ],
          };
          return;
        }
        yield { delta: "Done." };
      }
    }

    function runWithLegacyCallbacks(
      agent: Agent,
      userMessage: string,
    ): Promise<{ renders: Array<{ type: "success" | "error"; text: string }> }> {
      const renders: Array<{ type: "success" | "error"; text: string }> = [];
      return agent
        .streamChat(userMessage, () => {}, {
          onToolStart: () => {},
          onToolEnd: (_toolName, result, status) => {
            if (status !== "success") {
              renders.push({ type: "error", text: `${_toolName} failed` });
            } else {
              renders.push({ type: "success", text: `${_toolName} completed` });
            }
          },
        })
        .then(() => ({ renders }));
    }

    it("should render success for a working tool", async () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = new SingleToolCallProvider("list_dir");

      const { renders } = await runWithLegacyCallbacks(agent, "list files");

      expect(renders).toHaveLength(1);
      expect(renders[0].type).toBe("success");
      expect(renders[0].text).toContain("list_dir");
    });

    it("should render failure for a disabled tool", async () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      agent.disableTool("list_dir");
      (agent as any).provider = new SingleToolCallProvider("list_dir");

      const { renders } = await runWithLegacyCallbacks(agent, "list files");

      expect(renders).toHaveLength(1);
      expect(renders[0].type).toBe("error");
      expect(renders[0].text).toContain("list_dir");
    });

    it("should render failure for a missing tool", async () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = new SingleToolCallProvider(
        "nonexistent_tool_xyz",
      );

      const { renders } = await runWithLegacyCallbacks(agent, "run tool");

      expect(renders).toHaveLength(1);
      expect(renders[0].type).toBe("error");
      expect(renders[0].text).toContain("nonexistent_tool_xyz");
    });
  });
});
