import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  createProvider,
  type ChatMessage,
  type ChatTool,
  type ProviderConfig,
} from "@propio-ai/providers";
import { formatOperatorGuidance } from "../agent-core/runtime.js";

// Operator guidance puts a user message directly after tool results, and can
// put two user messages in a row. Every adapter has to build a request from
// that history. Nothing is sent: the transport is stubbed and the request the
// adapter built is inspected.

const model = { name: "Model", key: "m", contextWindowTokens: 100000 };
const adapters: Array<[string, Record<string, unknown>]> = [
  ["anthropic", { type: "anthropic", apiKey: "k" }],
  ["bedrock", { type: "bedrock", region: "us-east-1" }],
  ["ollama", { type: "ollama", host: "http://127.0.0.1:9" }],
  ["openrouter", { type: "openrouter", apiKey: "k" }],
  ["xai", { type: "xai", apiKey: "k" }],
  ["cloudflare", { type: "cloudflare", apiKey: "k", accountId: "a" }],
  ["gemini", { type: "gemini", apiKey: "k" }],
  ["openai", { type: "openai", apiKey: "k" }],
  [
    "openai (ChatGPT plan)",
    { type: "openai", auth: { mode: "chatgpt", accountId: "acct" } },
  ],
  ["meta", { type: "meta", apiKey: "k" }],
];

const tools: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "lookup",
      description: "Lookup",
      parameters: { type: "object", properties: { key: { type: "string" } } },
    },
  },
];

const system: ChatMessage = { role: "system", content: "Answer briefly." };
const assistantCall: ChatMessage = {
  role: "assistant",
  content: "",
  toolCalls: [
    { id: "call-1", function: { name: "lookup", arguments: { key: "a" } } },
  ],
};
const toolResult: ChatMessage = {
  role: "tool",
  content: "",
  toolResults: [
    { toolCallId: "call-1", toolName: "lookup", content: "RESULT-MARK" },
  ],
};
const guide = (mark: string): ChatMessage => ({
  role: "user",
  content: formatOperatorGuidance(mark),
});

const histories: Array<[string, ChatMessage[], string[]]> = [
  [
    "guidance after tool results",
    [
      system,
      { role: "user", content: "FIRST-MARK" },
      assistantCall,
      toolResult,
      guide("GUIDE-ONE"),
      guide("GUIDE-TWO"),
    ],
    ["FIRST-MARK", "RESULT-MARK", "GUIDE-ONE", "GUIDE-TWO"],
  ],
  [
    "guidance before the first request",
    [system, { role: "user", content: "FIRST-MARK" }, guide("GUIDE-ONE")],
    ["FIRST-MARK", "GUIDE-ONE"],
  ],
  [
    "guidance after a final answer",
    [
      system,
      { role: "user", content: "FIRST-MARK" },
      { role: "assistant", content: "ANSWER-MARK" },
      guide("GUIDE-ONE"),
    ],
    ["FIRST-MARK", "ANSWER-MARK", "GUIDE-ONE"],
  ],
];

describe.each(adapters)("%s adapter", (_label, config) => {
  let sent: string | undefined;

  beforeEach(() => {
    sent = undefined;
    jest.spyOn(globalThis, "fetch").mockImplementation((async (
      input: unknown,
      init?: { body?: unknown },
    ) => {
      const request = input as { body?: ReadableStream | null };
      sent =
        typeof init?.body === "string"
          ? init.body
          : request?.body
            ? await new Response(request.body).text()
            : String(init?.body);
      return new Response(JSON.stringify({ error: { message: "stubbed" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(histories)(
    "builds a request for %s",
    async (_name, messages, marks) => {
      const provider = createProvider(
        {
          name: "fixture",
          models: [model],
          defaultModel: "m",
          ...config,
        } as ProviderConfig,
        undefined,
        undefined,
        false,
        undefined,
        {
          openAiCredentialSource: () => ({
            getAccessToken: async () => "token",
          }),
        },
      );
      // The Bedrock adapter sends through an AWS client rather than fetch.
      const client = (provider as unknown as { client?: { send?: unknown } })
        .client;
      if (typeof client?.send === "function") {
        client.send = async (command: { input: unknown }) => {
          sent = JSON.stringify(command.input);
          throw Object.assign(new Error("stubbed"), {
            name: "ValidationException",
            $metadata: { httpStatusCode: 400 },
          });
        };
      }

      // The stubbed transport refuses the request; what matters is that the
      // adapter got as far as building one.
      await (async () => {
        for await (const _event of provider.streamChat({
          model: "m",
          messages,
          tools,
        })) {
          // Drain.
        }
      })().catch(() => {});

      expect(sent).toBeDefined();
      // Every part of the history is in the request, in the order given.
      const positions = marks.map((mark) => sent!.indexOf(mark));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    },
  );
});
