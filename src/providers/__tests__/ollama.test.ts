// Mock the Ollama package using unstable_mockModule for ESM
const mockChat = jest.fn();
const mockOllamaConstructor = jest.fn().mockImplementation(() => ({
  chat: mockChat,
}));

jest.unstable_mockModule("ollama", () => ({
  Ollama: mockOllamaConstructor,
}));

// Dynamic imports after mocks are set up
let OllamaProvider: any;

beforeAll(async () => {
  const ollamaModule = await import("../ollama.js");
  OllamaProvider = ollamaModule.OllamaProvider;
});

describe("OllamaProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Initialization", () => {
    it("should initialize with custom host", () => {
      const host = "http://custom-host:11434";
      new OllamaProvider({ model: "test-model", host });
      expect(mockOllamaConstructor).toHaveBeenCalledWith({ host });
    });

    it("should use localhost default when no host provided", () => {
      const originalEnv = process.env.OLLAMA_HOST;
      try {
        delete process.env.OLLAMA_HOST;
        new OllamaProvider({ model: "test-model" });
        expect(mockOllamaConstructor).toHaveBeenCalledWith({
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
        expect(mockOllamaConstructor).toHaveBeenCalledWith({
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
        const host = "http://explicit-host:11434";
        new OllamaProvider({ model: "test-model", host });
        expect(mockOllamaConstructor).toHaveBeenCalledWith({ host });
      } finally {
        process.env.OLLAMA_HOST = originalEnv;
      }
    });
  });

  describe("Backward compatibility", () => {
    it("should support custom host configuration", () => {
      const host = "http://custom:11434";
      new OllamaProvider({ model: "llama3.2", host });
      expect(mockOllamaConstructor).toHaveBeenCalledWith({ host });
    });

    it("should handle model parameter in constructor", () => {
      const provider = new OllamaProvider({ model: "llama3.2" });
      expect(provider).toBeDefined();
    });
  });

  describe("Provider identification", () => {
    it("should have name property set to ollama", () => {
      const provider = new OllamaProvider({ model: "test-model" });
      expect(provider.name).toBe("ollama");
    });
  });

  describe("streamChat", () => {
    it("should call ollama.chat with correct parameters", async () => {
      const provider = new OllamaProvider({ model: "test-model" });

      // Mock async generator
      mockChat.mockReturnValue(
        (async function* () {
          yield { message: { content: "Hello", tool_calls: undefined } };
        })(),
      );

      const messages: any[] = [{ role: "user", content: "test" }];

      const chunks: any[] = [];
      for await (const chunk of provider.streamChat({
        model: "test-model",
        messages,
      })) {
        chunks.push(chunk);
      }

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "test-model",
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "user", content: "test" }),
          ]),
          stream: true,
        }),
      );
    });

    it("should yield content deltas from ollama response", async () => {
      const provider = new OllamaProvider({ model: "test-model" });

      mockChat.mockReturnValue(
        (async function* () {
          yield { message: { content: "Hello " } };
          yield { message: { content: "world" } };
        })(),
      );

      const chunks: any[] = [];
      for await (const chunk of provider.streamChat({
        model: "test-model",
        messages: [{ role: "user", content: "test" }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].delta).toBe("Hello ");
      expect(chunks[1].delta).toBe("world");
    });

    it("should handle tool calls in response", async () => {
      const provider = new OllamaProvider({ model: "test-model" });

      mockChat.mockReturnValue(
        (async function* () {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "test_tool",
                    arguments: { arg: "value" },
                  },
                },
              ],
            },
          };
        })(),
      );

      const chunks: any[] = [];
      for await (const chunk of provider.streamChat({
        model: "test-model",
        messages: [{ role: "user", content: "test" }],
        tools: [
          {
            type: "function",
            function: {
              name: "test_tool",
              description: "test",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      })) {
        chunks.push(chunk);
      }

      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.toolCalls).toBeDefined();
      expect(lastChunk.toolCalls).toHaveLength(1);
      expect(lastChunk.toolCalls[0].function.name).toBe("test_tool");
    });

    it("should pass tools to ollama when provided", async () => {
      const provider = new OllamaProvider({ model: "test-model" });

      mockChat.mockReturnValue(
        (async function* () {
          yield { message: { content: "test" } };
        })(),
      );

      const tools: any[] = [
        {
          type: "function",
          function: {
            name: "test_tool",
            description: "test",
            parameters: { type: "object", properties: {} },
          },
        },
      ];

      for await (const chunk of provider.streamChat({
        model: "test-model",
        messages: [{ role: "user", content: "test" }],
        tools,
      })) {
        // consume stream
      }

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({
              type: "function",
              function: expect.objectContaining({
                name: "test_tool",
              }),
            }),
          ]),
        }),
      );
    });

    it("should expand batched tool results into separate messages", async () => {
      const provider = new OllamaProvider({ model: "test-model" });

      mockChat.mockReturnValue(
        (async function* () {
          yield { message: { content: "response" } };
        })(),
      );

      const messages: any[] = [
        { role: "user", content: "test" },
        {
          role: "tool",
          content: "",
          toolResults: [
            { toolCallId: "call1", toolName: "tool1", content: "result1" },
            { toolCallId: "call2", toolName: "tool2", content: "result2" },
          ],
        },
      ];

      for await (const chunk of provider.streamChat({
        model: "test-model",
        messages,
      })) {
        // consume stream
      }

      // Should have expanded the batched tool results into 3 messages:
      // 1. user message
      // 2. tool result 1
      // 3. tool result 2
      const callArgs = mockChat.mock.calls[0][0];
      expect(callArgs.messages).toHaveLength(3);
      expect(callArgs.messages[0].role).toBe("user");
      expect(callArgs.messages[1].role).toBe("tool");
      expect(callArgs.messages[1].content).toBe("result1");
      expect(callArgs.messages[2].role).toBe("tool");
      expect(callArgs.messages[2].content).toBe("result2");
    });
  });
});
