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
                  name: "list_directory",
                  arguments: {},
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

      expect(onToolStart).toHaveBeenCalledWith("list_directory");
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
        "list_directory",
        expect.any(String),
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

      expect(onToolStart).toHaveBeenCalledWith("list_directory");
      expect(onToolStart).toHaveBeenCalledTimes(1);
      expect(onToolEnd).toHaveBeenCalledWith(
        "list_directory",
        expect.any(String),
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
      );
      expect(onToolEnd).toHaveBeenNthCalledWith(
        2,
        "tool_two",
        expect.any(String),
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

      // Result should be a string
      expect(typeof result).toBe("string");
      // Result should not be empty
      expect(result.length).toBeGreaterThan(0);
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
});
