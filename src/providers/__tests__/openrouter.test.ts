import { OpenRouterProvider } from "../openrouter.js";
import {
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderModelNotFoundError,
  ProviderContextLengthError,
  ProviderError,
} from "../types.js";
import { ChatRequest, ChatMessage } from "../types.js";
import { AgentDiagnosticEvent } from "../../diagnostics.js";

const originalEnv = process.env;
const originalFetch = globalThis.fetch;

function createSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) =>
        controller.enqueue(new TextEncoder().encode(chunk)),
      );
      controller.close();
    },
  });
}

describe("OpenRouterProvider", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("should accept API key from options", () => {
      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test-key",
      });
      expect(provider.name).toBe("openrouter");
    });

    it("should use OPENROUTER_API_KEY env var when apiKey not in options", () => {
      process.env.OPENROUTER_API_KEY = "sk-env-key";
      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
      });
      expect(provider.name).toBe("openrouter");
    });

    it("should report DeepSeek V4 context windows", () => {
      const provider = new OpenRouterProvider({
        model: "deepseek/deepseek-v4-pro",
        apiKey: "sk-test-key",
      });
      expect(provider.getCapabilities().contextWindowTokens).toBe(1_000_000);
    });

    it("should throw ProviderAuthenticationError when no API key is provided", () => {
      delete process.env.OPENROUTER_API_KEY;
      expect(() => {
        new OpenRouterProvider({ model: "openai/gpt-3.5-turbo" });
      }).toThrow(ProviderAuthenticationError);
      expect(() => {
        new OpenRouterProvider({ model: "openai/gpt-3.5-turbo" });
      }).toThrow(/API key|OpenRouter/);
    });
  });

  describe("chat()", () => {
    it("should return ChatResponse with message when fetch succeeds", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello back"}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          chunks.forEach((c) =>
            controller.enqueue(new TextEncoder().encode(c)),
          );
          controller.close();
        },
      });
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: stream,
      });

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });
      const request: ChatRequest = {
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "Hello" }],
      };
      let fullContent = "";
      for await (const chunk of provider.streamChat(request)) {
        if ("delta" in chunk) {
          fullContent += chunk.delta;
        }
      }

      expect(fullContent).toBe("Hello back");
      expect(fetch).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer sk-test",
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("should translate messages to OpenAI format in request body", async () => {
      let capturedBody: unknown = null;
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Ok"}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          chunks.forEach((c) =>
            controller.enqueue(new TextEncoder().encode(c)),
          );
          controller.close();
        },
      });
      globalThis.fetch = jest
        .fn()
        .mockImplementation((_url: string, init?: RequestInit) => {
          capturedBody = init?.body ? JSON.parse(init.body as string) : null;
          return Promise.resolve({
            ok: true,
            body: stream,
          });
        });

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });
      const messages: ChatMessage[] = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ];
      for await (const chunk of provider.streamChat({
        model: "openai/gpt-3.5-turbo",
        messages,
      })) {
        // consume
      }

      expect(capturedBody).not.toBeNull();
      const body = capturedBody as {
        messages: unknown[];
        model: string;
        stream: boolean;
      };
      expect(body.model).toBe("openai/gpt-3.5-turbo");
      expect(body.stream).toBe(true);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]).toEqual({
        role: "system",
        content: "You are helpful",
      });
      expect(body.messages[1]).toEqual({ role: "user", content: "Hi" });
    });

    it("should include tools and handle tool_calls in request and response", async () => {
      let capturedBody: unknown = null;
      const chunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"loc"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\\":\\"NYC\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          chunks.forEach((c) =>
            controller.enqueue(new TextEncoder().encode(c)),
          );
          controller.close();
        },
      });
      globalThis.fetch = jest
        .fn()
        .mockImplementation((_url: string, init?: RequestInit) => {
          capturedBody = init?.body ? JSON.parse(init.body as string) : null;
          return Promise.resolve({
            ok: true,
            body: stream,
          });
        });

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });
      const request: ChatRequest = {
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "Weather in NYC?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      };
      let hasToolCalls = false;
      for await (const chunk of provider.streamChat(request)) {
        if (chunk.toolCalls) {
          hasToolCalls = true;
        }
      }

      const body = capturedBody as { tools?: unknown[] };
      expect(body.tools).toHaveLength(1);
      expect((body.tools as any)[0].function.name).toBe("get_weather");
      expect(hasToolCalls).toBe(true);
    });

    it("should include HTTP-Referer and X-OpenRouter-Title headers when configured", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          chunks.forEach((c) =>
            controller.enqueue(new TextEncoder().encode(c)),
          );
          controller.close();
        },
      });
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: stream,
      });

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        httpReferer: "https://myapp.com",
        xTitle: "My App",
      });
      for await (const chunk of provider.streamChat({
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "Hi" }],
      })) {
        // consume
      }

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "HTTP-Referer": "https://myapp.com",
            "X-OpenRouter-Title": "My App",
          }),
        }),
      );
    });

    it("should retry once without tools after a 429 and succeed", async () => {
      const diagnosticEvents: AgentDiagnosticEvent[] = [];
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
        })
        .mockResolvedValueOnce({
          ok: true,
          body: createSseStream([
            'data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        onDiagnosticEvent: (event) => diagnosticEvents.push(event),
        retryConfig: { maxRetries: 1, baseDelayMs: 0, consecutive529Limit: 3 },
      });

      const request: ChatRequest = {
        model: "openai/gpt-3.5-turbo",
        iteration: 3,
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Lookup",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      };

      let content = "";
      for await (const event of provider.streamChat(request)) {
        if (event.type === "assistant_text") {
          content += event.delta;
        }
      }

      expect(content).toBe("Recovered");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(firstBody.tools).toHaveLength(1);
      expect(secondBody.tools).toBeUndefined();
      expect(secondBody.model).toBe("openai/gpt-3.5-turbo");
      expect(secondBody.messages).toEqual(firstBody.messages);
      expect(secondBody.messages).toEqual([{ role: "user", content: "Hello" }]);

      expect(diagnosticEvents).toContainEqual(
        expect.objectContaining({
          type: "provider_retry",
          provider: "openrouter",
          model: "openai/gpt-3.5-turbo",
          iteration: 3,
        }),
      );
    });

    it("should normalize DSML tool markup during a retry without native tools", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
        })
        .mockResolvedValueOnce({
          ok: true,
          body: createSseStream([
            'data: {"choices":[{"delta":{"content":"<｜DSML｜tool_calls>\\n<｜DSML｜invoke name=\\"read\\">\\n<｜DSML｜parameter name=\\"path\\"\\nstring=\\"true\\">/Users/isaacheist/Code/propio-agent/src/sandboxDelegation.ts</｜DSML｜parameter>\\n"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"<｜DSML｜parameter name=\\"offset\\" string=\\"false\\">50</｜DSML｜parameter>\\n</｜DSML｜invoke>\\n</｜DSML｜tool_calls>"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "deepseek/deepseek-v3.1",
        apiKey: "sk-test",
        retryConfig: { maxRetries: 1, baseDelayMs: 0, consecutive529Limit: 3 },
      });

      const assistantText: string[] = [];
      const toolCalls: unknown[] = [];
      for await (const event of provider.streamChat({
        model: "deepseek/deepseek-v3.1",
        iteration: 2,
        messages: [{ role: "user", content: "Read more" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "Read a file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      })) {
        if (event.type === "assistant_text") {
          assistantText.push(event.delta);
        }
        if (event.type === "tool_calls") {
          toolCalls.push(event.toolCalls);
        }
      }

      expect(assistantText.join("")).not.toContain("<｜DSML｜tool_calls>");
      expect(toolCalls).toHaveLength(1);
      expect((toolCalls[0] as any)[0].function.name).toBe("read");
      expect((toolCalls[0] as any)[0].function.arguments).toEqual({
        path: "/Users/isaacheist/Code/propio-agent/src/sandboxDelegation.ts",
        offset: 50,
      });

      const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(retryBody.tools).toBeUndefined();
    });

    it("should preserve reasoning content on streamed tool calls", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"reasoning_content":"I should inspect the file."}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"package.json\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ];
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: createSseStream(chunks),
      });

      const provider = new OpenRouterProvider({
        model: "deepseek/deepseek-v4-pro",
        apiKey: "sk-test",
      });

      const toolEvents: unknown[] = [];
      for await (const event of provider.streamChat({
        model: "deepseek/deepseek-v4-pro",
        messages: [{ role: "user", content: "Inspect package" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "Read a file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      })) {
        if (event.type === "tool_calls") {
          toolEvents.push(event);
        }
      }

      expect(toolEvents).toHaveLength(1);
      expect((toolEvents[0] as any).reasoningContent).toBe(
        "I should inspect the file.",
      );
    });

    it("should send reasoning content back on assistant tool-call messages", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        body: createSseStream(["data: [DONE]\n\n"]),
      });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "deepseek/deepseek-v4-pro",
        apiKey: "sk-test",
      });

      for await (const _event of provider.streamChat({
        model: "deepseek/deepseek-v4-pro",
        messages: [
          { role: "user", content: "Inspect package" },
          {
            role: "assistant",
            content: "",
            reasoningContent: "I should inspect the file.",
            toolCalls: [
              {
                id: "call_1",
                function: {
                  name: "read",
                  arguments: { path: "package.json" },
                },
              },
            ],
          },
          {
            role: "tool",
            content: "package contents",
            toolCallId: "call_1",
          },
        ],
      })) {
        // consume
      }

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.messages[1].reasoning_content).toBe(
        "I should inspect the file.",
      );
    });

    it("should retry once without tools after a 503 and succeed", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
        })
        .mockResolvedValueOnce({
          ok: true,
          body: createSseStream([
            'data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        retryConfig: { maxRetries: 1, baseDelayMs: 0, consecutive529Limit: 3 },
      });

      const request: ChatRequest = {
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Lookup",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      };

      let content = "";
      for await (const event of provider.streamChat(request)) {
        if (event.type === "assistant_text") {
          content += event.delta;
        }
      }

      expect(content).toBe("Recovered");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(secondBody.tools).toBeUndefined();
    });

    it("should preserve model and messages when retrying without tools", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
        })
        .mockResolvedValueOnce({
          ok: true,
          body: createSseStream([
            'data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        retryConfig: { maxRetries: 1, baseDelayMs: 0, consecutive529Limit: 3 },
      });

      const request: ChatRequest = {
        model: "openai/gpt-3.5-turbo",
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Lookup",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      };

      for await (const _event of provider.streamChat(request)) {
        // consume
      }

      const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(secondBody.model).toBe(firstBody.model);
      expect(secondBody.messages).toEqual(firstBody.messages);
      expect(secondBody.tools).toBeUndefined();
    });

    it("should retry on 429 even without tools", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
      });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        retryConfig: { maxRetries: 1, baseDelayMs: 0, consecutive529Limit: 3 },
      });

      await expect(async () => {
        for await (const _event of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hello" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderRateLimitError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("should retry on 503 even without tools", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        retryConfig: { maxRetries: 1, baseDelayMs: 0, consecutive529Limit: 3 },
      });

      await expect(async () => {
        for await (const _event of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hello" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("should throw ProviderAuthenticationError on 401", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderAuthenticationError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(/Invalid OpenRouter API key/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("should throw ProviderRateLimitError on 429 with retry-after", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Map([["retry-after", "60"]]),
      });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        retryConfig: { maxRetries: 0, baseDelayMs: 0, consecutive529Limit: 3 },
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderRateLimitError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should surface OpenRouter upstream details on 429 response bodies", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Map(),
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: {
                message: "Provider returned error",
                metadata: {
                  retry_after_seconds: 7,
                  raw: JSON.stringify({
                    error: {
                      message: "Rate limit exceeded",
                    },
                    provider_name: "Together",
                  }),
                },
              },
            }),
          ),
      });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        retryConfig: { maxRetries: 0, baseDelayMs: 0, consecutive529Limit: 3 },
      });

      let caughtError: unknown;
      try {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(ProviderRateLimitError);
      expect((caughtError as ProviderRateLimitError).message).toContain(
        "Together",
      );
      expect((caughtError as ProviderRateLimitError).message).toContain(
        "Rate limit exceeded",
      );
      expect((caughtError as ProviderRateLimitError).retryAfterSeconds).toBe(7);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should throw ProviderModelNotFoundError on 404", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderModelNotFoundError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should throw ProviderError on 402", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 402,
      });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        retryConfig: { maxRetries: 0, baseDelayMs: 0, consecutive529Limit: 3 },
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(/Insufficient OpenRouter credits/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("should throw ProviderError on 5xx", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        retryConfig: { maxRetries: 0, baseDelayMs: 0, consecutive529Limit: 3 },
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(/OpenRouter service error/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("should surface upstream provider details on 503 response bodies", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: {
                message: "Provider returned error",
                metadata: {
                  raw: JSON.stringify({
                    error: {
                      message: "Service unavailable",
                    },
                    provider_name: "Together",
                  }),
                },
              },
            }),
          ),
      });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        retryConfig: { maxRetries: 0, baseDelayMs: 0, consecutive529Limit: 3 },
      });

      let caughtError: unknown;
      try {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(ProviderError);
      expect((caughtError as Error).message).toContain("Together");
      expect((caughtError as Error).message).toContain("Service unavailable");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should include upstream details and retry-after text if the retry also fails", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                error: {
                  message: "Provider returned error",
                  metadata: {
                    retry_after_seconds: 11,
                    raw: JSON.stringify({
                      error: {
                        message: "Service unavailable",
                      },
                      provider_name: "Together",
                    }),
                  },
                },
              }),
            ),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                error: {
                  message: "Provider returned error",
                  metadata: {
                    retry_after_seconds: 13,
                    raw: JSON.stringify({
                      error: {
                        message: "Upstream still unavailable",
                        metadata: { retry_after_seconds: 13 },
                      },
                      provider_name: "Together",
                    }),
                  },
                },
              }),
            ),
        });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        retryConfig: { maxRetries: 1, baseDelayMs: 0, consecutive529Limit: 3 },
      });

      let caughtError: unknown;
      try {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
          tools: [
            {
              type: "function",
              function: {
                name: "lookup",
                description: "Lookup",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        })) {
          // consume
        }
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(ProviderError);
      expect((caughtError as Error).message).toContain("Together");
      expect((caughtError as Error).message).toContain(
        "Upstream still unavailable",
      );
      expect((caughtError as Error).message).toContain("retry after 13s");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("should throw ProviderError on network failure", async () => {
      const fetchMock = jest.fn().mockRejectedValue(new Error("fetch failed"));
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should serialize OpenRouter routing fields, fallback models, and debug echo body", async () => {
      let capturedBody: unknown = null;
      const fetchMock = jest
        .fn()
        .mockImplementation((_url: string, init?: RequestInit) => {
          capturedBody = init?.body ? JSON.parse(init.body as string) : null;
          return Promise.resolve({
            ok: true,
            body: createSseStream([
              'data: {"choices":[{"delta":{"content":"Ok"}}]}\n\n',
              "data: [DONE]\n\n",
            ]),
          });
        });
      globalThis.fetch = fetchMock;

      const diagnosticEvents: AgentDiagnosticEvent[] = [];
      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        provider: {
          allowFallbacks: false,
          order: ["provider-a", "provider-b"],
          requireParameters: true,
        },
        fallbackModels: ["openai/gpt-4o-mini", "openai/gpt-4.1-mini"],
        debugEchoUpstreamBody: true,
        debugLoggingEnabled: true,
        onDiagnosticEvent: (event) => diagnosticEvents.push(event),
      });

      for await (const _event of provider.streamChat({
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "Hello" }],
      })) {
        // consume
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(diagnosticEvents).toHaveLength(0);
      expect(capturedBody).toEqual({
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
        provider: {
          allow_fallbacks: false,
          order: ["provider-a", "provider-b"],
          require_parameters: true,
        },
        models: ["openai/gpt-4o-mini", "openai/gpt-4.1-mini"],
        debug: { echo_upstream_body: true },
      });
    });

    it("should throw ProviderContextLengthError on 400 with context length message in body", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: {
                message:
                  "This model's maximum context length is 128000 tokens. However, your messages resulted in 200000 tokens.",
              },
            }),
          ),
      });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderContextLengthError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should throw generic ProviderError on 400 without context length message", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({ error: { message: "Invalid request format" } }),
          ),
      });
      globalThis.fetch = fetchMock;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
        retryConfig: { maxRetries: 0, baseDelayMs: 0, consecutive529Limit: 3 },
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.not.toThrow(ProviderContextLengthError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("streamChat()", () => {
    it("should yield content deltas from mocked SSE stream", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          chunks.forEach((c) =>
            controller.enqueue(new TextEncoder().encode(c)),
          );
          controller.close();
        },
      });
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: stream,
      });

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });
      const request: ChatRequest = {
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "Hi" }],
      };
      const deltas: string[] = [];
      for await (const chunk of provider.streamChat(request)) {
        deltas.push(chunk.delta);
      }
      expect(deltas).toEqual(["Hello", " world"]);
    });

    it("should accumulate tool_calls across chunks and yield final chunk", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"loc"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\\":\\"NYC\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          chunks.forEach((c) =>
            controller.enqueue(new TextEncoder().encode(c)),
          );
          controller.close();
        },
      });
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: stream,
      });

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });
      const request: ChatRequest = {
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "Weather?" }],
      };
      const results: Array<{ delta: string; toolCalls?: unknown[] }> = [];
      for await (const chunk of provider.streamChat(request)) {
        results.push({ delta: chunk.delta, toolCalls: chunk.toolCalls });
      }
      const withToolCalls = results.filter(
        (r) => r.toolCalls && r.toolCalls.length > 0,
      );
      expect(withToolCalls).toHaveLength(1);
      expect(withToolCalls[0].toolCalls).toHaveLength(1);
      expect((withToolCalls[0].toolCalls as any)[0].function.name).toBe(
        "get_weather",
      );
      expect((withToolCalls[0].toolCalls as any)[0].function.arguments).toEqual(
        { location: "NYC" },
      );
    });

    it("should normalize DSML tool markup into structured tool_calls", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"<｜DSML｜tool_calls><｜DSML｜invoke name=\\"lookup\\"><｜DSML｜parameter name=\\"query\\" string=\\"true\\">hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>"}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const stream = createSseStream(chunks);
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: stream,
      });

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });
      const request: ChatRequest = {
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "Lookup hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Lookup",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      };

      const assistantText: string[] = [];
      const toolCalls: unknown[] = [];
      for await (const event of provider.streamChat(request)) {
        if (event.type === "assistant_text") {
          assistantText.push(event.delta);
        }
        if (event.type === "tool_calls") {
          toolCalls.push(event.toolCalls);
        }
      }

      expect(assistantText.join("")).not.toContain("<｜DSML｜tool_calls>");
      expect(toolCalls).toHaveLength(1);
      expect((toolCalls[0] as any)[0].function.name).toBe("lookup");
      expect((toolCalls[0] as any)[0].function.arguments).toEqual({
        query: "hello",
      });
    });

    it("should throw when a tool-enabled response yields no usable output", async () => {
      const stream = createSseStream(["data: [DONE]\n\n"]);
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: stream,
      });

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });

      await expect(async () => {
        for await (const _event of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hello" }],
          tools: [
            {
              type: "function",
              function: {
                name: "lookup",
                description: "Lookup",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        })) {
          // consume
        }
      }).rejects.toThrow(/no usable assistant output/i);
    });

    it("should stop on [DONE] marker", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        "data: [DONE]\n\n",
        'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
      ];
      const stream = new ReadableStream({
        start(controller) {
          chunks.forEach((c) =>
            controller.enqueue(new TextEncoder().encode(c)),
          );
          controller.close();
        },
      });
      globalThis.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, body: stream });

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });
      const deltas: string[] = [];
      for await (const chunk of provider.streamChat({
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "Hi" }],
      })) {
        deltas.push(chunk.delta);
      }
      expect(deltas).toEqual(["Hi"]);
    });

    it("should skip malformed JSON lines", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        "data: not-json\n\n",
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          chunks.forEach((c) =>
            controller.enqueue(new TextEncoder().encode(c)),
          );
          controller.close();
        },
      });
      globalThis.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, body: stream });

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });
      const deltas: string[] = [];
      for await (const chunk of provider.streamChat({
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "Hi" }],
      })) {
        deltas.push(chunk.delta);
      }
      expect(deltas).toEqual(["Hi"]);
    });

    it("should expand batched tool results into individual messages", async () => {
      const chunks = ['data: {"choices":[{"delta":{"content":"Done"}}]}\n\n'];
      const stream = new ReadableStream({
        start(controller) {
          chunks.forEach((c) =>
            controller.enqueue(new TextEncoder().encode(c)),
          );
          controller.close();
        },
      });

      const mockFetch = jest.fn().mockResolvedValue({ ok: true, body: stream });
      globalThis.fetch = mockFetch;

      const provider = new OpenRouterProvider({
        model: "openai/gpt-3.5-turbo",
        apiKey: "sk-test",
      });

      // Create a message with batched tool results
      const messages: ChatMessage[] = [
        { role: "user", content: "Test" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call1", function: { name: "tool1", arguments: {} } },
            { id: "call2", function: { name: "tool2", arguments: {} } },
          ],
        },
        {
          role: "tool",
          content: "",
          toolResults: [
            { toolCallId: "call1", toolName: "tool1", content: "result1" },
            { toolCallId: "call2", toolName: "tool2", content: "result2" },
          ],
        },
      ];

      const deltas: string[] = [];
      for await (const chunk of provider.streamChat({
        model: "openai/gpt-3.5-turbo",
        messages,
      })) {
        deltas.push(chunk.delta);
      }

      // Verify the request body was sent with expanded tool messages
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"role":"tool"'),
        }),
      );

      // Parse the request body to verify structure
      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const toolMessages = requestBody.messages.filter(
        (m: any) => m.role === "tool",
      );

      // Should have 2 individual tool messages, not 1 batched message
      expect(toolMessages).toHaveLength(2);
      expect(toolMessages[0]).toMatchObject({
        role: "tool",
        content: "result1",
        tool_call_id: "call1",
      });
      expect(toolMessages[1]).toMatchObject({
        role: "tool",
        content: "result2",
        tool_call_id: "call2",
      });
    });
  });
});
