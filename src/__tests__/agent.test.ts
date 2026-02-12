import * as fs from "fs";
import * as path from "path";
import { Agent } from "../agent.js";
import { LLMProvider } from "../providers/interface.js";
import {
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ChatMessage,
} from "../providers/types.js";
import { ProvidersConfig } from "../providers/config.js";

/**
 * Mock LLM Provider for testing
 */
class MockProvider implements LLMProvider {
  name = "mock";
  streamChatCalls: ChatRequest[] = [];

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

    it("should accept systemPrompt and sessionContextFilePath options", () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        systemPrompt: "Custom prompt",
        sessionContextFilePath: path.join(tempDir, "session.txt"),
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
      expect(typeof agent.saveContext).toBe("function");
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
  });
});
