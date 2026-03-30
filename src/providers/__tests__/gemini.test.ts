import { GeminiProvider } from "../gemini.js";
import {
  ProviderAuthenticationError,
  ProviderContextLengthError,
  ProviderError,
  ProviderModelNotFoundError,
  ProviderRateLimitError,
} from "../types.js";
import { ChatMessage, ChatRequest } from "../types.js";

const originalEnv = process.env;
const originalFetch = globalThis.fetch;

function createSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

describe("GeminiProvider", () => {
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
      const provider = new GeminiProvider({
        model: "gemini-3.1-pro-preview",
        apiKey: "gemini-test-key",
      });
      expect(provider.name).toBe("gemini");
    });

    it("should use GEMINI_API_KEY env var when apiKey not in options", () => {
      process.env.GEMINI_API_KEY = "gemini-env-key";
      const provider = new GeminiProvider({
        model: "gemini-3.1-pro-preview",
      });
      expect(provider.name).toBe("gemini");
    });

    it("should fall back to GOOGLE_API_KEY when GEMINI_API_KEY is missing", () => {
      delete process.env.GEMINI_API_KEY;
      process.env.GOOGLE_API_KEY = "google-env-key";
      const provider = new GeminiProvider({
        model: "gemini-3.1-pro-preview",
      });
      expect(provider.name).toBe("gemini");
    });

    it("should throw ProviderAuthenticationError when no API key is provided", () => {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      expect(() => {
        new GeminiProvider({ model: "gemini-3.1-pro-preview" });
      }).toThrow(ProviderAuthenticationError);
      expect(() => {
        new GeminiProvider({ model: "gemini-3.1-pro-preview" });
      }).toThrow(/API key|Gemini/);
    });

    it("should report the requested 1,048,576 token context window for gemini preview models", () => {
      const models = [
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite-preview",
      ];

      for (const model of models) {
        const provider = new GeminiProvider({
          model,
          apiKey: "gemini-test-key",
        });
        expect(provider.getCapabilities().contextWindowTokens).toBe(1_048_576);
      }
    });

    it("should reject unsupported Gemini models at construction time", () => {
      expect(
        () =>
          new GeminiProvider({
            model: "gemini-unknown-preview",
            apiKey: "gemini-test-key",
          }),
      ).toThrow(ProviderModelNotFoundError);
    });
  });

  describe("streamChat()", () => {
    it("should translate messages, images, and batched tool results into the Gemini request body", async () => {
      let capturedBody: unknown = null;
      globalThis.fetch = jest
        .fn()
        .mockImplementation((_url: string, init?: RequestInit) => {
          capturedBody = init?.body ? JSON.parse(init.body as string) : null;
          return Promise.resolve({
            ok: true,
            body: createSseStream([
              'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
              "data: [DONE]\n\n",
            ]),
          });
        });

      const provider = new GeminiProvider({
        model: "gemini-3.1-pro-preview",
        apiKey: "gemini-test-key",
      });

      const request: ChatRequest = {
        model: "gemini-3.1-pro-preview",
        messages: [
          { role: "system", content: "You are helpful" },
          {
            role: "user",
            content: "Look",
            images: ["data:image/png;base64,iVBORw0KGgo="],
          },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_1",
                thoughtSignature: "sig-1",
                function: {
                  name: "get_weather",
                  arguments: { location: "NYC" },
                },
              },
            ],
          },
          {
            role: "tool",
            content: "",
            toolResults: [
              {
                toolCallId: "call_1",
                toolName: "get_weather",
                content: "sunny",
              },
              {
                toolCallId: "call_2",
                toolName: "get_time",
                content: "noon",
              },
            ],
          },
        ],
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

      for await (const chunk of provider.streamChat(request)) {
        if (chunk.delta === "ok") {
          break;
        }
      }

      expect(capturedBody).not.toBeNull();
      const body = capturedBody as {
        model: string;
        stream: boolean;
        messages: Array<{
          role: string;
          content: string | Array<unknown>;
          tool_call_id?: string;
        }>;
        tools?: unknown[];
      };
      expect(body.model).toBe("gemini-3.1-pro-preview");
      expect(body.stream).toBe(true);
      expect(body.tools).toHaveLength(1);
      expect(body.messages).toHaveLength(5);
      expect(body.messages[1].role).toBe("user");
      expect(Array.isArray(body.messages[1].content)).toBe(true);
      const userContent = body.messages[1].content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(userContent[0]).toEqual({ type: "text", text: "Look" });
      expect(userContent[1].type).toBe("image_url");
      expect(userContent[1].image_url?.url).toContain("data:image/png;base64");
      expect(body.messages[2]).toMatchObject({
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            extra_content: {
              google: {
                thought_signature: "sig-1",
              },
            },
          },
        ],
      });
      expect(body.messages[3]).toMatchObject({
        role: "tool",
        content: "sunny",
        tool_call_id: "call_1",
      });
      expect(body.messages[4]).toMatchObject({
        role: "tool",
        content: "noon",
        tool_call_id: "call_2",
      });
    });

    it("should stream assistant text and tool calls from SSE chunks", async () => {
      const toolCallStart = JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  extra_content: {
                    google: {
                      thought_signature: "sig-1",
                    },
                  },
                  function: { name: "get_weather" },
                },
              ],
            },
          },
        ],
      });
      const toolCallArgs1 = JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"location":"NY' },
                },
              ],
            },
          },
        ],
      });
      const toolCallArgs2 = JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'C"}' },
                },
              ],
            },
          },
        ],
      });

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: createSseStream([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          `data: ${toolCallStart}\n\n`,
          `data: ${toolCallArgs1}\n\n`,
          `data: ${toolCallArgs2}\n\n`,
          "data: [DONE]\n\n",
        ]),
      });

      const provider = new GeminiProvider({
        model: "gemini-3.1-pro-preview",
        apiKey: "gemini-test-key",
      });

      const request: ChatRequest = {
        model: "gemini-3.1-pro-preview",
        messages: [{ role: "user", content: "Hi" }],
      };

      const deltas: string[] = [];
      let toolCalls: unknown[] | undefined;
      for await (const chunk of provider.streamChat(request)) {
        if ("type" in chunk && chunk.type === "assistant_text") {
          deltas.push(chunk.delta);
        }
        if ("type" in chunk && chunk.type === "tool_calls") {
          toolCalls = chunk.toolCalls;
        }
      }

      expect(deltas).toEqual(["Hello", " world"]);
      expect(toolCalls).toHaveLength(1);
      const parsedToolCalls = toolCalls as Array<{
        thoughtSignature?: string;
        function: { name: string; arguments: Record<string, string> };
      }>;
      expect(parsedToolCalls[0].function.name).toBe("get_weather");
      expect(parsedToolCalls[0].function.arguments.location).toBe("NYC");
      expect(parsedToolCalls[0].thoughtSignature).toBe("sig-1");
    });

    it("should emit tool calls when Gemini uses camelCase toolCalls and stop finish reasons", async () => {
      const toolCallChunk = JSON.stringify({
        choices: [
          {
            delta: {
              toolCalls: [
                {
                  index: 0,
                  id: "call_2",
                  extra_content: {
                    google: {
                      thought_signature: "sig-2",
                    },
                  },
                  function: {
                    name: "list_files",
                    arguments: '{"path":"."}',
                  },
                },
              ],
            },
            finish_reason: "stop",
          },
        ],
      });

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: createSseStream([
          `data: ${toolCallChunk}\n\n`,
          "data: [DONE]\n\n",
        ]),
      });

      const provider = new GeminiProvider({
        model: "gemini-3.1-pro-preview",
        apiKey: "gemini-test-key",
      });

      const request: ChatRequest = {
        model: "gemini-3.1-pro-preview",
        messages: [{ role: "user", content: "What is in this repo?" }],
      };

      let toolCalls: unknown[] | undefined;
      for await (const chunk of provider.streamChat(request)) {
        if ("type" in chunk && chunk.type === "tool_calls") {
          toolCalls = chunk.toolCalls;
        }
      }

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls?.[0]).toMatchObject({
        id: "call_2",
        thoughtSignature: "sig-2",
        function: {
          name: "list_files",
          arguments: { path: "." },
        },
      });
    });

    it("should throw ProviderAuthenticationError on 401", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers(),
      });

      const provider = new GeminiProvider({
        model: "gemini-3.1-pro-preview",
        apiKey: "gemini-test-key",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "gemini-3.1-pro-preview",
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
        headers: new Headers([["retry-after", "30"]]),
      });

      const provider = new GeminiProvider({
        model: "gemini-3.1-pro-preview",
        apiKey: "gemini-test-key",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "gemini-3.1-pro-preview",
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
        headers: new Headers(),
      });

      const provider = new GeminiProvider({
        model: "gemini-3.1-pro-preview",
        apiKey: "gemini-test-key",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "gemini-3.1-pro-preview",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderModelNotFoundError);
    });

    it("should throw ProviderContextLengthError on context-length failures", async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({
            error: { message: "prompt is too long for the model" },
          }),
      });

      const provider = new GeminiProvider({
        model: "gemini-3.1-pro-preview",
        apiKey: "gemini-test-key",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "gemini-3.1-pro-preview",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderContextLengthError);
    });

    it("should translate network failures into ProviderError", async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error("fetch failed"));

      const provider = new GeminiProvider({
        model: "gemini-3.1-pro-preview",
        apiKey: "gemini-test-key",
      });
      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "gemini-3.1-pro-preview",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderError);
    });

    it("should reject unsupported request model overrides", async () => {
      globalThis.fetch = jest.fn();

      const provider = new GeminiProvider({
        model: "gemini-3.1-pro-preview",
        apiKey: "gemini-test-key",
      });

      await expect(async () => {
        for await (const chunk of provider.streamChat({
          model: "gemini-unknown-preview",
          messages: [{ role: "user", content: "Hi" }],
        })) {
          // consume
        }
      }).rejects.toThrow(ProviderModelNotFoundError);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
