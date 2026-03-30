import { XaiProvider } from "../xai.js";
import {
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderModelNotFoundError,
  ProviderContextLengthError,
  ProviderError,
} from "../types.js";
import { ChatRequest, ChatMessage } from "../types.js";

const originalEnv = process.env;
const originalFetch = globalThis.fetch;

describe("XaiProvider", () => {
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
      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test-key",
      });
      expect(provider.name).toBe("xai");
    });

    it("should use XAI_API_KEY env var when apiKey not in options", () => {
      process.env.XAI_API_KEY = "xai-env-key";
      const provider = new XaiProvider({ model: "grok-4-1-fast-reasoning" });
      expect(provider.name).toBe("xai");
    });

    it("should throw ProviderAuthenticationError when no API key is provided", () => {
      delete process.env.XAI_API_KEY;
      expect(() => {
        new XaiProvider({ model: "grok-4-1-fast-reasoning" });
      }).toThrow(ProviderAuthenticationError);
      expect(() => {
        new XaiProvider({ model: "grok-4-1-fast-reasoning" });
      }).toThrow(/API key|xAI/);
    });

    it("should report the updated 2M token context window for current Grok models", () => {
      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test-key",
      });

      expect(provider.getCapabilities().contextWindowTokens).toBe(2_000_000);
    });

    it("should default unknown xAI models to the updated 2M token context window", () => {
      const provider = new XaiProvider({
        model: "grok-future-model",
        apiKey: "xai-test-key",
      });

      expect(provider.getCapabilities().contextWindowTokens).toBe(2_000_000);
    });
  });

  describe("streamChat()", () => {
    it("should yield content deltas from mocked SSE stream", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" Grok"}}]}\n\n',
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

      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test",
      });
      const request: ChatRequest = {
        model: "grok-4-1-fast-reasoning",
        messages: [{ role: "user", content: "Hello" }],
      };
      const deltas: string[] = [];
      for await (const chunk of provider.streamChat(request)) {
        deltas.push(chunk.delta);
      }
      expect(deltas).toEqual(["Hello", " Grok"]);
    });

    it("should call the xAI API endpoint with correct auth header", async () => {
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

      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test",
      });
      for await (const chunk of provider.streamChat({
        model: "grok-4-1-fast-reasoning",
        messages: [{ role: "user", content: "Hi" }],
      })) {
        // consume
      }

      expect(fetch).toHaveBeenCalledWith(
        "https://api.x.ai/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer xai-test",
            "Content-Type": "application/json",
          }),
        }),
      );
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

      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test",
      });

      const messages: ChatMessage[] = [
        { role: "user", content: "Test" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call1", function: { name: "tool1", arguments: {} } },
          ],
        },
        {
          role: "tool",
          content: "",
          toolResults: [
            { toolCallId: "call1", toolName: "tool1", content: "result1" },
          ],
        },
      ];

      for await (const chunk of provider.streamChat({
        model: "grok-4-1-fast-reasoning",
        messages,
      })) {
        // consume
      }

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const toolMessages = requestBody.messages.filter(
        (m: any) => m.role === "tool",
      );
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]).toMatchObject({
        role: "tool",
        content: "result1",
        tool_call_id: "call1",
      });
    });

    it("should throw ProviderAuthenticationError on 401", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });

      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "grok-4-1-fast-reasoning",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderAuthenticationError);
    });

    it("should throw ProviderRateLimitError on 429", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Map([["retry-after", "30"]]),
      });

      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "grok-4-1-fast-reasoning",
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

      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "grok-4-1-fast-reasoning",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderModelNotFoundError);
    });

    it("should throw ProviderError on 5xx", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve("upstream connect error"),
      });

      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "grok-4-1-fast-reasoning",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderError);
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "grok-4-1-fast-reasoning",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(/upstream connect error/);
    });

    it("should throw ProviderError on network failure", async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error("fetch failed"));

      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "grok-4-1-fast-reasoning",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderError);
    });

    it("should throw ProviderContextLengthError on 400 with context length message in body", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: {
                message:
                  "This model's maximum context length is 131072 tokens. However, your messages resulted in 200000 tokens.",
              },
            }),
          ),
      });

      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "grok-4-1-fast-reasoning",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderContextLengthError);
    });

    it("should throw generic ProviderError on 400 without context length message", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({ error: { message: "Invalid request format" } }),
          ),
      });

      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "grok-4-1-fast-reasoning",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderError);
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "grok-4-1-fast-reasoning",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.not.toThrow(ProviderContextLengthError);
    });

    it("should fall back to a regional endpoint when the global endpoint returns 503", async () => {
      const successChunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const successStream = new ReadableStream({
        start(controller) {
          successChunks.forEach((c) =>
            controller.enqueue(new TextEncoder().encode(c)),
          );
          controller.close();
        },
      });

      globalThis.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: () => Promise.resolve("upstream connect error"),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: successStream,
        });

      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        apiKey: "xai-test",
      });

      const deltas: string[] = [];
      for await (const chunk of provider.streamChat({
        model: "grok-4-1-fast-reasoning",
        messages: [{ role: "user", content: "Hi" }],
      })) {
        deltas.push(chunk.delta);
      }

      expect(deltas).toEqual(["Hello"]);
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        "https://api.x.ai/v1/chat/completions",
        expect.any(Object),
      );
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        "https://us-east-1.api.x.ai/v1/chat/completions",
        expect.any(Object),
      );
    });
  });
});
