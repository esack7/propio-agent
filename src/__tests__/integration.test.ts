import { Agent } from "../agent.js";
import { LLMProvider } from "../providers/interface.js";
import { ChatRequest, ChatResponse, ChatChunk } from "../providers/types.js";
import { ProvidersConfig } from "../providers/config.js";
import * as fs from "fs";
import * as path from "path";

// Test providers config using new format
const defaultTestProvidersConfig: ProvidersConfig = {
  default: "local-ollama",
  providers: [
    {
      name: "local-ollama",
      type: "ollama",
      models: [{ name: "Test Model", key: "test-model" }],
      defaultModel: "test-model",
      host: "http://localhost:11434",
    },
  ],
};

/**
 * Mock provider for integration testing
 */
class MockIntegrationProvider implements LLMProvider {
  name: string;

  constructor(name: string = "mock") {
    this.name = name;
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const chunks = `Response from ${this.name}`.split(" ");
    for (const chunk of chunks) {
      yield { delta: chunk + " " };
    }
  }
}

describe("Agent Integration Tests", () => {
  describe("Public API", () => {
    it("should maintain existing chat interface", async () => {
      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      // Verify methods exist and have correct signatures
      expect(typeof agent.streamChat).toBe("function");
      expect(typeof agent.getContext).toBe("function");
      expect(typeof agent.getTools).toBe("function");
      expect(typeof agent.saveContext).toBe("function");
    });
  });

  describe("Provider initialization", () => {
    it("should throw error when no provider config is provided", () => {
      expect(() => new Agent()).toThrow("Provider configuration is required");
    });

    it("should support Ollama configuration", () => {
      const config: ProvidersConfig = {
        default: "ollama",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [{ name: "Model", key: "custom-model" }],
            defaultModel: "custom-model",
            host: "http://custom:11434",
          },
        ],
      };
      const agent = new Agent({ providersConfig: config });
      expect(agent).toBeDefined();
    });

    it("should support Bedrock configuration", () => {
      const config: ProvidersConfig = {
        default: "bedrock",
        providers: [
          {
            name: "bedrock",
            type: "bedrock",
            models: [
              {
                name: "Claude",
                key: "anthropic.claude-3-sonnet-20240229-v1:0",
              },
            ],
            defaultModel: "anthropic.claude-3-sonnet-20240229-v1:0",
            region: "us-west-2",
          },
        ],
      };
      const agent = new Agent({ providersConfig: config });
      expect(agent).toBeDefined();
    });
  });

  describe("Session context management", () => {
    it("should maintain session context across multiple chat calls", async () => {
      const mockProvider = new MockIntegrationProvider("test");
      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("First message", () => {});
      expect(agent.getContext().length).toBeGreaterThan(0);

      const contextAfterFirst = agent.getContext().length;
      await agent.streamChat("Second message", () => {});

      expect(agent.getContext().length).toBeGreaterThan(contextAfterFirst);
    });

    it("should clear context correctly", async () => {
      const mockProvider = new MockIntegrationProvider("test");
      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Test message", () => {});
      expect(agent.getContext().length).toBeGreaterThan(0);

      agent.clearContext();
      expect(agent.getContext().length).toBe(0);
    });

    it("should handle system prompt changes", async () => {
      const mockProvider = new MockIntegrationProvider("test");
      let receivedSystemPrompt = "";

      mockProvider.streamChat = async function* (request: ChatRequest) {
        const systemMsg = request.messages.find((m) => m.role === "system");
        if (systemMsg) {
          receivedSystemPrompt = systemMsg.content;
        }
        yield { delta: "Response" };
      };

      const agent = new Agent({
        providersConfig: defaultTestProvidersConfig,
        systemPrompt: "Original prompt",
      });
      (agent as any).provider = mockProvider;

      const newPrompt = "Updated prompt";
      agent.setSystemPrompt(newPrompt);

      await agent.streamChat("Test", () => {});
      // Verify new prompt is used in provider call
      expect(receivedSystemPrompt).toBe(newPrompt);
    });
  });

  describe("Tool execution", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = path.join(process.cwd(), `.test-${Date.now()}`);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    });

    it("should execute file write tool correctly", async () => {
      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });

      const result = await agent.saveContext("integration test");

      expect(result).toContain("Successfully saved");
    });

    it("should handle tool execution errors gracefully", async () => {
      const mockProvider = new MockIntegrationProvider("test");
      mockProvider.streamChat = async function* () {
        yield {
          delta: "Calling tool",
          toolCalls: [
            {
              function: {
                name: "read_file",
                arguments: { file_path: "/nonexistent/file.txt" },
              },
            },
          ],
        };
      };

      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      (agent as any).provider = mockProvider;

      // Should not throw, but add error message to context
      await expect(agent.streamChat("Test", () => {})).resolves.toBeDefined();

      const context = agent.getContext();
      const toolMessage = context.find((m) => m.role === "tool");
      // With batched tool results, check toolResults array
      expect(
        toolMessage?.toolResults?.[0]?.content || toolMessage?.content,
      ).toContain("Error");
    });

    it("should handle multiple tool calls in sequence", async () => {
      const mockProvider = new MockIntegrationProvider("test");
      let callCount = 0;

      mockProvider.streamChat = async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            delta: "First tool call",
            toolCalls: [
              {
                function: {
                  name: "save_session_context",
                  arguments: { reason: "test1" },
                },
              },
            ],
          };
        } else if (callCount === 2) {
          yield {
            delta: "Second tool call",
            toolCalls: [
              {
                function: {
                  name: "save_session_context",
                  arguments: { reason: "test2" },
                },
              },
            ],
          };
        } else {
          yield { delta: "Done" };
        }
      };

      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      (agent as any).provider = mockProvider;

      const response = await agent.streamChat("Execute tools", () => {});
      expect(response).toBe("Done");
      expect(callCount).toBe(3); // Initial + 2 tool executions + final response
    });
  });

  describe("Streaming functionality", () => {
    it("should stream tokens correctly", async () => {
      const mockProvider = new MockIntegrationProvider("test");
      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      (agent as any).provider = mockProvider;

      const tokens: string[] = [];
      const response = await agent.streamChat("Test", (token) => {
        if (token) tokens.push(token);
      });

      expect(tokens.length).toBeGreaterThan(0);
      expect(response.length).toBeGreaterThan(0);
    });

    it("should accumulate streamed response correctly", async () => {
      const mockProvider = new MockIntegrationProvider("test");
      mockProvider.streamChat = async function* () {
        yield { delta: "Hello " };
        yield { delta: "world" };
        yield { delta: "!" };
      };

      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      (agent as any).provider = mockProvider;

      const response = await agent.streamChat("Test", () => {});
      expect(response).toBe("Hello world!");
    });

    it("should handle tool calls in streaming", async () => {
      const mockProvider = new MockIntegrationProvider("test");
      let callCount = 0;

      mockProvider.streamChat = async function* () {
        callCount++;
        if (callCount === 1) {
          // First stream: with tool calls
          yield { delta: "Calling " };
          yield { delta: "tool" };
          yield {
            delta: "",
            toolCalls: [
              {
                function: {
                  name: "save_session_context",
                  arguments: {},
                },
              },
            ],
          };
        } else {
          // Second stream: after tool execution
          yield { delta: "Done" };
        }
      };

      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      (agent as any).provider = mockProvider;

      const tokens: string[] = [];
      const response = await agent.streamChat("Test", (token) => {
        if (token) tokens.push(token);
      });

      // Response should be 'Done' from second iteration (after tool execution)
      expect(response).toBe("Done");
      // Verify tool was executed (context should have tool message)
      const context = agent.getContext();
      expect(context.some((m) => m.role === "tool")).toBe(true);
    });
  });

  describe("Provider switching", () => {
    it("should switch provider while preserving context", async () => {
      const provider1 = new MockIntegrationProvider("provider1");
      const config: ProvidersConfig = {
        default: "ollama",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [{ name: "Model1", key: "model1" }],
            defaultModel: "model1",
          },
          {
            name: "ollama-alt",
            type: "ollama",
            models: [{ name: "Model2", key: "model2" }],
            defaultModel: "model2",
          },
        ],
      };

      const agent = new Agent({ providersConfig: config });
      (agent as any).provider = provider1;

      await agent.streamChat("First message with provider 1", () => {});
      const contextSize = agent.getContext().length;

      (agent as any).switchProvider("ollama-alt");

      // Context should be preserved
      const newContextSize = agent.getContext().length;
      expect(newContextSize).toBe(contextSize);
    });

    it("should work correctly after switching providers", async () => {
      const config: ProvidersConfig = {
        default: "ollama",
        providers: [
          {
            name: "ollama",
            type: "ollama",
            models: [{ name: "Model", key: "model" }],
            defaultModel: "model",
          },
        ],
      };

      const agent = new Agent({ providersConfig: config });
      const mockProvider = new MockIntegrationProvider("switched");
      (agent as any).provider = mockProvider;

      const response = await agent.streamChat("After switch", () => {});
      expect(response).toContain("switched");
    });
  });

  describe("Error handling", () => {
    it("should handle provider errors gracefully", async () => {
      const mockProvider = new MockIntegrationProvider("test");
      mockProvider.streamChat = async function* () {
        throw new Error("Provider error");
      };

      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      (agent as any).provider = mockProvider;

      await expect(agent.streamChat("Test", () => {})).rejects.toThrow();
    });

    it("should provide useful error messages", async () => {
      const mockProvider = new MockIntegrationProvider("test-provider");
      mockProvider.streamChat = async function* () {
        throw new Error("Connection failed");
      };

      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      (agent as any).provider = mockProvider;

      try {
        await agent.streamChat("Test", () => {});
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toContain("test-provider");
        }
      }
    });
  });

  describe("Context persistence", () => {
    it("should maintain context across calls", async () => {
      const mockProvider = new MockIntegrationProvider("test");
      mockProvider.streamChat = async function* (request: ChatRequest) {
        yield { delta: `Received ${request.messages.length} messages` };
      };

      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Message 1", () => {});
      const contextAfter1 = agent.getContext().length;

      await agent.streamChat("Message 2", () => {});
      const contextAfter2 = agent.getContext().length;

      expect(contextAfter2).toBeGreaterThan(contextAfter1);
    });
  });

  describe("System prompt handling", () => {
    it("should include system prompt in all requests", async () => {
      const mockProvider = new MockIntegrationProvider("test");
      const systemPromptUsed: string[] = [];

      mockProvider.streamChat = async function* (request: ChatRequest) {
        const systemMsg = request.messages.find((m) => m.role === "system");
        if (systemMsg) {
          systemPromptUsed.push(systemMsg.content);
        }
        yield { delta: "Response" };
      };

      const customPrompt = "Custom system prompt";
      const agent = new Agent({
        providersConfig: defaultTestProvidersConfig,
        systemPrompt: customPrompt,
      });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Test 1", () => {});
      await agent.streamChat("Test 2", () => {});

      expect(systemPromptUsed).toHaveLength(2);
      expect(systemPromptUsed[0]).toBe(customPrompt);
      expect(systemPromptUsed[1]).toBe(customPrompt);
    });
  });

  describe("Tools availability", () => {
    it("should provide all tools", () => {
      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      const tools = agent.getTools();

      const toolNames = tools.map((t) => t.function.name);
      expect(toolNames).toContain("save_session_context");
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_file");
    });

    it("should pass tools to provider", async () => {
      const mockProvider = new MockIntegrationProvider("test");
      const toolsReceived: any[] = [];

      mockProvider.streamChat = async function* (request: ChatRequest) {
        if (request.tools) {
          toolsReceived.push(...request.tools);
        }
        yield { delta: "Response" };
      };

      const agent = new Agent({ providersConfig: defaultTestProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat("Test with tools", () => {});

      expect(toolsReceived.length).toBeGreaterThan(0);
      expect(
        toolsReceived.some((t) => t.function.name === "save_session_context"),
      ).toBe(true);
    });
  });
});
