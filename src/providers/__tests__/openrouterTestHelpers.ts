import { OpenRouterProvider } from "../openrouter.js";
import type { ChatMessage, ChatRequest, ChatStreamEvent } from "../types.js";

const DEFAULT_CHAT_REQUEST: ChatRequest = {
  model: "openai/gpt-3.5-turbo",
  messages: [{ role: "user", content: "Hi" }] satisfies ChatMessage[],
};

type StreamingProvider = {
  streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
};

export class OpenRouterTestFixture {
  static createSseStream(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) =>
          controller.enqueue(new TextEncoder().encode(chunk)),
        );
        controller.close();
      },
    });
  }

  static setupFetchMock(
    chunks: string[],
    captureBody?: (body: unknown) => void,
  ): jest.Mock {
    const mock = jest
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) => {
        if (captureBody && init?.body) {
          captureBody(JSON.parse(init.body as string));
        }
        return Promise.resolve({
          ok: true,
          body: OpenRouterTestFixture.createSseStream(chunks),
        });
      });
    globalThis.fetch = mock;
    return mock;
  }

  static createProvider(
    model = "openai/gpt-3.5-turbo",
    apiKey = "sk-test",
    retryConfig?: {
      maxRetries: number;
      baseDelayMs: number;
      consecutive529Limit: number;
    },
  ): OpenRouterProvider {
    return new OpenRouterProvider({ model, apiKey, retryConfig });
  }

  static createRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
    return {
      ...DEFAULT_CHAT_REQUEST,
      ...overrides,
      messages: overrides.messages ?? DEFAULT_CHAT_REQUEST.messages,
    };
  }

  static async consumeStream(
    provider: StreamingProvider,
    request: ChatRequest = DEFAULT_CHAT_REQUEST,
  ): Promise<ChatStreamEvent[]> {
    const events: ChatStreamEvent[] = [];
    for await (const event of provider.streamChat(request)) {
      events.push(event);
    }
    return events;
  }

  static async collectDeltas(
    provider: StreamingProvider,
    request: ChatRequest = DEFAULT_CHAT_REQUEST,
  ): Promise<string[]> {
    return (await OpenRouterTestFixture.consumeStream(provider, request)).map(
      (event) => event.delta,
    );
  }

  static async expectStreamChatToThrow(
    provider: OpenRouterProvider,
    matcher: string | RegExp | (new (...args: unknown[]) => unknown),
    request: ChatRequest = DEFAULT_CHAT_REQUEST,
  ): Promise<void> {
    await expect(async () => {
      for await (const _chunk of provider.streamChat(request)) {
        // consume
      }
    }).rejects.toThrow(matcher as any);
  }
}
