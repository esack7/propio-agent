import { OpenRouterProvider } from "../openrouter.js";
import type { ChatMessage } from "../types.js";

const DEFAULT_CHAT_REQUEST = {
  model: "openai/gpt-3.5-turbo",
  messages: [{ role: "user" as const, content: "Hi" }] satisfies ChatMessage[],
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

  static async expectStreamChatToThrow(
    provider: OpenRouterProvider,
    matcher: string | RegExp | (new (...args: unknown[]) => unknown),
  ): Promise<void> {
    await expect(async () => {
      for await (const _chunk of provider.streamChat(DEFAULT_CHAT_REQUEST)) {
        // consume
      }
    }).rejects.toThrow(matcher as any);
  }
}
