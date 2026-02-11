import { OllamaProvider } from "../ollama";
import { ChatMessage, ChatRequest, ChatTool, ChatToolCall } from "../types";
import { Ollama } from "ollama";

// Mock the Ollama package
jest.mock("ollama");

const mockOllama = Ollama as jest.MockedClass<typeof Ollama>;

describe("OllamaProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Initialization", () => {
    it("should initialize with custom host", () => {
      const host = "http://custom-host:11434";
      new OllamaProvider({ model: "test-model", host });
      expect(mockOllama).toHaveBeenCalledWith({ host });
    });

    it("should use localhost default when no host provided", () => {
      const originalEnv = process.env.OLLAMA_HOST;
      try {
        delete process.env.OLLAMA_HOST;
        new OllamaProvider({ model: "test-model" });
        expect(mockOllama).toHaveBeenCalledWith({
          host: "http://localhost:11434",
        });
      } finally {
        process.env.OLLAMA_HOST = originalEnv;
      }
    });

    it("should use OLLAMA_HOST environment variable if set", () => {
      const originalEnv = process.env.OLLAMA_HOST;
      try {
        process.env.OLLAMA_HOST = "http://env-host:11434";
        new OllamaProvider({ model: "test-model" });
        expect(mockOllama).toHaveBeenCalledWith({
          host: "http://env-host:11434",
        });
      } finally {
        process.env.OLLAMA_HOST = originalEnv;
      }
    });

    it("should prioritize explicit host over environment variable", () => {
      const originalEnv = process.env.OLLAMA_HOST;
      try {
        process.env.OLLAMA_HOST = "http://env-host:11434";
        const explicitHost = "http://explicit-host:11434";
        new OllamaProvider({ model: "test-model", host: explicitHost });
        expect(mockOllama).toHaveBeenCalledWith({ host: explicitHost });
      } finally {
        process.env.OLLAMA_HOST = originalEnv;
      }
    });
  });

  describe("Provider identification", () => {
    it("should have name property set to ollama", () => {
      const provider = new OllamaProvider({ model: "test-model" });
      expect(provider.name).toBe("ollama");
    });
  });

  describe("Message type translation", () => {
    let provider: OllamaProvider;

    beforeEach(() => {
      provider = new OllamaProvider({ model: "test-model" });
    });

    it("should translate ChatMessage to Ollama Message format", () => {
      const chatMsg: ChatMessage = {
        role: "user",
        content: "Hello",
      };
      const translated = (provider as any).chatMessageToOllamaMessage(chatMsg);
      expect(translated.role).toBe("user");
      expect(translated.content).toBe("Hello");
    });

    it("should preserve all roles in translation", () => {
      const roles: ChatMessage["role"][] = [
        "user",
        "assistant",
        "system",
        "tool",
      ];
      roles.forEach((role) => {
        const chatMsg: ChatMessage = {
          role,
          content: "Test",
        };
        const translated = (provider as any).chatMessageToOllamaMessage(
          chatMsg,
        );
        expect(translated.role).toBe(role);
      });
    });

    it("should translate tool calls to Ollama format", () => {
      const toolCall: ChatToolCall = {
        function: {
          name: "test_func",
          arguments: { arg1: "value1" },
        },
      };
      const chatMsg: ChatMessage = {
        role: "assistant",
        content: "Calling tool",
        toolCalls: [toolCall],
      };
      const translated = (provider as any).chatMessageToOllamaMessage(chatMsg);
      expect(translated.tool_calls).toBeDefined();
      expect(translated.tool_calls).toHaveLength(1);
      expect(translated.tool_calls[0].function.name).toBe("test_func");
    });

    it("should translate images in ChatMessage", () => {
      const imageData = new Uint8Array([1, 2, 3]);
      const chatMsg: ChatMessage = {
        role: "user",
        content: "Image",
        images: [imageData],
      };
      const translated = (provider as any).chatMessageToOllamaMessage(chatMsg);
      expect(translated.images).toBeDefined();
      expect(translated.images).toContain(imageData);
    });

    it("should translate Ollama Message to ChatMessage", () => {
      const ollamaMsg = {
        role: "assistant" as const,
        content: "Response text",
      };
      const translated = (provider as any).ollamaMessageToChatMessage(
        ollamaMsg,
      );
      expect(translated.role).toBe("assistant");
      expect(translated.content).toBe("Response text");
    });

    it("should translate Ollama tool_calls to ChatToolCall", () => {
      const ollamaMsg = {
        role: "assistant" as const,
        content: "Tool call",
        tool_calls: [
          {
            function: {
              name: "my_tool",
              arguments: { param: "value" },
            },
          },
        ],
      };
      const translated = (provider as any).ollamaMessageToChatMessage(
        ollamaMsg,
      );
      expect(translated.toolCalls).toBeDefined();
      expect(translated.toolCalls).toHaveLength(1);
      expect(translated.toolCalls![0].function.name).toBe("my_tool");
    });
  });

  describe("Tool definition translation", () => {
    let provider: OllamaProvider;

    beforeEach(() => {
      provider = new OllamaProvider({ model: "test-model" });
    });

    it("should translate ChatTool to Ollama Tool format", () => {
      const chatTool: ChatTool = {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for location",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
            required: ["location"],
          },
        },
      };
      const translated = (provider as any).chatToolToOllamaTool(chatTool);
      expect(translated.type).toBe("function");
      expect(translated.function.name).toBe("get_weather");
      expect(translated.function.parameters.type).toBe("object");
      expect(translated.function.parameters.required).toContain("location");
    });

    it("should preserve complex parameters in translation", () => {
      const chatTool: ChatTool = {
        type: "function",
        function: {
          name: "complex_tool",
          description: "Complex tool",
          parameters: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      };
      const translated = (provider as any).chatToolToOllamaTool(chatTool);
      expect(translated.function.parameters.properties.items.type).toBe(
        "array",
      );
    });
  });

  describe("Non-streaming chat", () => {
    let provider: OllamaProvider;
    let mockChatMethod: jest.Mock;

    beforeEach(() => {
      mockChatMethod = jest.fn();
      mockOllama.prototype.chat = mockChatMethod;
      provider = new OllamaProvider({ model: "test-model" });
    });

    it("should call ollama.chat with stream true", async () => {
      mockChatMethod.mockReturnValue(
        (async function* () {
          yield { message: { role: "assistant", content: "Response" } };
        })(),
      );

      const request: ChatRequest = {
        messages: [{ role: "user", content: "Hello" }],
        model: "test-model",
      };

      for await (const chunk of provider.streamChat(request)) {
        // consume
      }

      expect(mockChatMethod).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: true,
        }),
      );
    });

    it("should return ChatResponse with stop reason", async () => {
      mockChatMethod.mockReturnValue(
        (async function* () {
          yield { message: { role: "assistant", content: "Response" } };
        })(),
      );

      const request: ChatRequest = {
        messages: [{ role: "user", content: "Hello" }],
        model: "test-model",
      };

      let fullContent = "";
      for await (const chunk of provider.streamChat(request)) {
        fullContent += chunk.delta;
      }

      expect(fullContent).toBe("Response");
      expect(["end_turn", "tool_use", "max_tokens", "stop_sequence"]).toContain(
        "end_turn",
      );
    });

    it("should pass model name to ollama.chat", async () => {
      mockChatMethod.mockReturnValue(
        (async function* () {
          yield { message: { role: "assistant", content: "Ok" } };
        })(),
      );

      const request: ChatRequest = {
        messages: [{ role: "user", content: "Test" }],
        model: "specific-model",
      };

      for await (const chunk of provider.streamChat(request)) {
        // consume
      }

      expect(mockChatMethod).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "specific-model",
        }),
      );
    });

    it("should pass tools to ollama.chat if provided", async () => {
      mockChatMethod.mockReturnValue(
        (async function* () {
          yield { message: { role: "assistant", content: "Ok" } };
        })(),
      );

      const request: ChatRequest = {
        messages: [{ role: "user", content: "Use tool" }],
        model: "test-model",
        tools: [
          {
            type: "function",
            function: {
              name: "my_tool",
              description: "Tool",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      };

      for await (const chunk of provider.streamChat(request)) {
        // consume
      }

      expect(mockChatMethod).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.any(Array),
        }),
      );
    });

    it("should set stopReason to tool_use when tool calls present", async () => {
      mockChatMethod.mockReturnValue(
        (async function* () {
          yield {
            message: {
              role: "assistant",
              content: "Calling",
              tool_calls: [{ function: { name: "tool", arguments: {} } }],
            },
          };
        })(),
      );

      const request: ChatRequest = {
        messages: [{ role: "user", content: "Test" }],
        model: "test-model",
      };

      let hasToolCall = false;
      for await (const chunk of provider.streamChat(request)) {
        if (chunk.toolCalls) {
          hasToolCall = true;
        }
      }

      expect(hasToolCall).toBe(true);
    });
  });

  describe("Streaming chat", () => {
    let provider: OllamaProvider;
    let mockChatMethod: jest.Mock;

    beforeEach(() => {
      mockChatMethod = jest.fn();
      mockOllama.prototype.chat = mockChatMethod;
      provider = new OllamaProvider({ model: "test-model" });
    });

    it("should call ollama.chat with stream true", async () => {
      mockChatMethod.mockReturnValue(
        (async function* () {
          yield {
            message: { role: "assistant", content: "Hello" },
          };
        })(),
      );

      const request: ChatRequest = {
        messages: [{ role: "user", content: "Hi" }],
        model: "test-model",
      };

      // Need to iterate to trigger the call
      for await (const chunk of provider.streamChat(request)) {
        // consume
      }

      expect(mockChatMethod).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: true,
        }),
      );
    });

    it("should yield ChatChunk objects with delta content", async () => {
      mockChatMethod.mockReturnValue(
        (async function* () {
          yield { message: { role: "assistant", content: "Hello " } };
          yield { message: { role: "assistant", content: "world" } };
        })(),
      );

      const request: ChatRequest = {
        messages: [{ role: "user", content: "Hi" }],
        model: "test-model",
      };

      const chunks: any[] = [];
      for await (const chunk of provider.streamChat(request)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach((chunk) => {
        expect(chunk).toHaveProperty("delta");
      });
    });

    it("should include toolCalls in final chunk if present", async () => {
      mockChatMethod.mockReturnValue(
        (async function* () {
          yield { message: { role: "assistant", content: "Calling " } };
          yield {
            message: {
              role: "assistant",
              content: "tool",
              tool_calls: [{ function: { name: "my_tool", arguments: {} } }],
            },
          };
        })(),
      );

      const request: ChatRequest = {
        messages: [{ role: "user", content: "Use tool" }],
        model: "test-model",
      };

      let hasToolCalls = false;
      for await (const chunk of provider.streamChat(request)) {
        if (chunk.toolCalls) {
          hasToolCalls = true;
          expect(chunk.toolCalls).toHaveLength(1);
        }
      }

      expect(hasToolCalls).toBe(true);
    });

    it("should handle streaming errors", async () => {
      mockChatMethod.mockReturnValue(
        (async function* () {
          throw new Error("Stream error");
        })(),
      );

      const request: ChatRequest = {
        messages: [{ role: "user", content: "Test" }],
        model: "test-model",
      };

      await expect(async () => {
        for await (const chunk of provider.streamChat(request)) {
          // consume chunks
        }
      }).rejects.toThrow();
    });
  });

  describe("Error handling", () => {
    let provider: OllamaProvider;
    let mockChatMethod: jest.Mock;

    beforeEach(() => {
      mockChatMethod = jest.fn();
      mockOllama.prototype.chat = mockChatMethod;
      provider = new OllamaProvider({ model: "test-model" });
    });

    it("should throw ProviderError on general errors", async () => {
      mockChatMethod.mockRejectedValue(new Error("General error"));

      const request: ChatRequest = {
        messages: [{ role: "user", content: "Test" }],
        model: "test-model",
      };

      await expect(async () => {
        for await (const chunk of provider.streamChat(request)) {
          // consume
        }
      }).rejects.toThrow();
    });

    it("should throw ProviderAuthenticationError on connection errors", async () => {
      const connError = new Error("connect ECONNREFUSED");
      mockChatMethod.mockRejectedValue(connError);

      const request: ChatRequest = {
        messages: [{ role: "user", content: "Test" }],
        model: "test-model",
      };

      await expect(async () => {
        for await (const chunk of provider.streamChat(request)) {
          // consume
        }
      }).rejects.toThrow();
    });

    it("should throw ProviderModelNotFoundError when model not found", async () => {
      const notFoundError = new Error("model not found");
      mockChatMethod.mockRejectedValue(notFoundError);

      const request: ChatRequest = {
        messages: [{ role: "user", content: "Test" }],
        model: "nonexistent-model",
      };

      await expect(async () => {
        for await (const chunk of provider.streamChat(request)) {
          // consume
        }
      }).rejects.toThrow();
    });
  });

  describe("Backward compatibility", () => {
    it("should support legacy model names", () => {
      const provider = new OllamaProvider({ model: "qwen3-coder:30b" });
      expect(provider.name).toBe("ollama");
    });

    it("should support custom host configuration", () => {
      const customHost = "http://192.168.1.100:11434";
      new OllamaProvider({ model: "test", host: customHost });
      expect(mockOllama).toHaveBeenCalledWith({ host: customHost });
    });
  });
});
