import { OpenRouterProvider } from "../openrouter";
import {
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderModelNotFoundError,
  ProviderError,
} from "../types";
import { ChatRequest, ChatMessage } from "../types";

const originalEnv = process.env;
const originalFetch = globalThis.fetch;

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
        fullContent += chunk.delta;
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
      for await (const chunk of provider.streamChat({ model: "openai/gpt-3.5-turbo", messages })) {
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

    it("should include HTTP-Referer and X-Title headers when configured", async () => {
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
            "X-Title": "My App",
          }),
        }),
      );
    });

    it("should throw ProviderAuthenticationError on 401", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });

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
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(/Invalid OpenRouter API key/);
    });

    it("should throw ProviderRateLimitError on 429 with retry-after", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Map([["retry-after", "60"]]),
      });
      (globalThis.fetch as jest.Mock).mock.results = [];

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
      }).rejects.toThrow(ProviderRateLimitError);
    });

    it("should throw ProviderModelNotFoundError on 404", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

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
    });

    it("should throw ProviderError on 402", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 402,
      });

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
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(/Insufficient OpenRouter credits/);
    });

    it("should throw ProviderError on 5xx", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });

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
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(/OpenRouter service error/);
    });

    it("should throw ProviderError on network failure", async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error("fetch failed"));

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
  });
});
