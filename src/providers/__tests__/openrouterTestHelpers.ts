import { OpenRouterProvider } from "../openrouter.js";

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
  ): OpenRouterProvider {
    return new OpenRouterProvider({ model, apiKey });
  }
}
