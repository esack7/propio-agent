import { XaiProvider } from "../xai.js";
import {
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderModelNotFoundError,
  ProviderContextLengthError,
  ProviderError,
} from "../types.js";
import { ChatRequest, ChatMessage } from "../types.js";
import {
  OpenRouterTestFixture,
  registerAcceptsApiKeyTest,
  registerProviderTestLifecycle,
} from "./openrouterTestHelpers.js";

const originalEnv = process.env;
const originalFetch = globalThis.fetch;
const DEFAULT_MODEL = "grok-4-1-fast-reasoning";
const DEFAULT_CONTEXT_WINDOW = 2_000_000;
const DEFAULT_REQUEST: ChatRequest = {
  model: DEFAULT_MODEL,
  messages: [{ role: "user", content: "Hi" }],
};

const createSseStream = OpenRouterTestFixture.createSseStream;

function createProvider(
  options: Partial<ConstructorParameters<typeof XaiProvider>[0]> = {},
): XaiProvider {
  return new XaiProvider({
    model: DEFAULT_MODEL,
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
    apiKey: "xai-test",
    ...options,
  });
}

function createRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    ...DEFAULT_REQUEST,
    ...overrides,
    messages: overrides.messages ?? DEFAULT_REQUEST.messages,
  };
}

async function expectStreamChatToThrow(
  provider: XaiProvider,
  matcher: string | RegExp | (new (...args: unknown[]) => unknown),
  request: ChatRequest = DEFAULT_REQUEST,
): Promise<void> {
  await expect(async () => {
    for await (const _chunk of provider.streamChat(request)) {
      // consume
    }
  }).rejects.toThrow(matcher as any);
}

async function expectRequestError(
  response: Record<string, unknown>,
  matcher: string | RegExp | (new (...args: unknown[]) => unknown),
  providerOptions: Partial<ConstructorParameters<typeof XaiProvider>[0]> = {},
): Promise<void> {
  globalThis.fetch = jest.fn().mockResolvedValue(response);
  await expectStreamChatToThrow(createProvider(providerOptions), matcher);
}

async function expectProviderErrorAndMessage(
  response: Record<string, unknown>,
  messageMatcher: string | RegExp,
  providerOptions: Partial<ConstructorParameters<typeof XaiProvider>[0]> = {},
): Promise<void> {
  globalThis.fetch = jest.fn().mockResolvedValue(response);
  const provider = createProvider(providerOptions);
  await expectStreamChatToThrow(provider, ProviderError);
  await expectStreamChatToThrow(provider, messageMatcher);
}

async function collectToolMessages(
  messages: ChatMessage[],
): Promise<unknown[]> {
  const mockFetch = jest.fn().mockResolvedValue({
    ok: true,
    body: createSseStream([
      'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
    ]),
  });
  globalThis.fetch = mockFetch;

  for await (const _chunk of createProvider().streamChat(
    createRequest({ messages }),
  )) {
    // consume
  }

  const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
  return requestBody.messages.filter((message: any) => message.role === "tool");
}

describe("XaiProvider", () => {
  registerProviderTestLifecycle(originalEnv, originalFetch);

  describe("constructor", () => {
    registerAcceptsApiKeyTest({
      expectedName: "xai",
      createProvider: () =>
        new XaiProvider({
          model: "grok-4-1-fast-reasoning",
          contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
          apiKey: "xai-test-key",
        }),
    });

    it("should use XAI_API_KEY env var when apiKey not in options", () => {
      process.env.XAI_API_KEY = "xai-env-key";
      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
      });
      expect(provider.name).toBe("xai");
    });

    it("should throw ProviderAuthenticationError when no API key is provided", () => {
      delete process.env.XAI_API_KEY;
      expect(() => {
        new XaiProvider({
          model: "grok-4-1-fast-reasoning",
          contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
        });
      }).toThrow(ProviderAuthenticationError);
      expect(() => {
        new XaiProvider({
          model: "grok-4-1-fast-reasoning",
          contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
        });
      }).toThrow(/API key|xAI/);
    });

    it("should report the configured context window for current Grok models", () => {
      const provider = new XaiProvider({
        model: "grok-4-1-fast-reasoning",
        contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
        apiKey: "xai-test-key",
      });

      expect(provider.getCapabilities().contextWindowTokens).toBe(2_000_000);
    });

    it("should report the configured context window for newly configured xAI models", () => {
      const provider = new XaiProvider({
        model: "grok-4.3",
        contextWindowTokens: 1_000_000,
        apiKey: "xai-test-key",
      });

      expect(provider.getCapabilities().contextWindowTokens).toBe(1_000_000);
    });
  });

  describe("streamChat()", () => {
    it("should yield content deltas from mocked SSE stream", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" Grok"}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: createSseStream(chunks),
      });

      const provider = createProvider();
      const request = createRequest({
        messages: [{ role: "user", content: "Hello" }],
      });
      const deltas: string[] = [];
      for await (const chunk of provider.streamChat(request)) {
        deltas.push(chunk.delta);
      }
      expect(deltas).toEqual(["Hello", " Grok"]);
    });

    it("should use the Responses API and emit thinking deltas when reasoning is requested", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: createSseStream([
          'data: {"type":"response.reasoning_summary_text.delta","delta":"Planning. "}\n\n',
          'data: {"type":"response.output_text.delta","delta":"Answer."}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        ]),
      });

      const provider = createProvider();
      const thinkingEvents: string[] = [];
      const assistantText: string[] = [];

      for await (const chunk of provider.streamChat(
        createRequest({ requestReasoning: true }),
      )) {
        if (chunk.type === "thinking_delta") {
          thinkingEvents.push(chunk.delta);
        }
        if (chunk.type === "assistant_text") {
          assistantText.push(chunk.delta);
        }
      }

      expect(thinkingEvents).toEqual(["Planning. "]);
      expect(assistantText).toEqual(["Answer."]);
      expect(fetch).toHaveBeenCalledWith(
        "https://api.x.ai/v1/responses",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer xai-test",
          }),
        }),
      );
      const requestBody = JSON.parse(
        (fetch as jest.Mock).mock.calls[0][1].body,
      );
      expect(requestBody.stream).toBe(true);
      expect(requestBody.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Hi" }] },
      ]);
    });

    it("should call the xAI API endpoint with correct auth header", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: createSseStream(chunks),
      });

      const provider = createProvider();
      for await (const chunk of provider.streamChat(createRequest())) {
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
      const toolMessages = await collectToolMessages([
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
      ]);

      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]).toMatchObject({
        role: "tool",
        content: "result1",
        tool_call_id: "call1",
      });
    });

    it("should throw ProviderAuthenticationError on 401", async () => {
      await expectRequestError(
        { ok: false, status: 401 },
        ProviderAuthenticationError,
      );
    });

    it("should throw ProviderRateLimitError on 429", async () => {
      await expectRequestError(
        {
          ok: false,
          status: 429,
          headers: new Map([["retry-after", "30"]]),
        },
        ProviderRateLimitError,
      );
    });

    it("should throw ProviderModelNotFoundError on 404", async () => {
      await expectRequestError(
        { ok: false, status: 404 },
        ProviderModelNotFoundError,
      );
    });

    it("should throw ProviderError on 5xx", async () => {
      await expectProviderErrorAndMessage(
        {
          ok: false,
          status: 503,
          text: () => Promise.resolve("upstream connect error"),
        },
        /upstream connect error/,
        { retryConfig: { maxRetries: 0, consecutive529Limit: 1 } },
      );
    });

    it("should throw ProviderError on network failure", async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error("fetch failed"));
      await expectStreamChatToThrow(createProvider(), ProviderError);
    });

    it("should throw ProviderContextLengthError on 400 with context length message in body", async () => {
      await expectRequestError(
        {
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
        },
        ProviderContextLengthError,
      );
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

      const provider = createProvider({
        retryConfig: { maxRetries: 0, consecutive529Limit: 1 },
      });
      await expectStreamChatToThrow(provider, ProviderError);
      await expect(async () => {
        for await (const _chunk of provider.streamChat(DEFAULT_REQUEST)) {
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
        contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
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
