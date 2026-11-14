import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { createProvider, type LLMProvider } from "@propio-ai/providers";
import { createCliTurnSession } from "../cli/turnSession.js";
import { TerminalUi } from "../ui/terminal.js";
import { createTtyTestStream } from "../ui/__tests__/ttyTestStream.js";
import { createTestAgent } from "./testHelpers.js";

// A JPEG attachment, from the terminal or from another frontend, must reach
// the provider as a JPEG. Nothing is sent: each adapter's transport is
// stubbed and the request it built is inspected.

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const JPEG_BASE64 = Buffer.from(JPEG).toString("base64");
const model = { name: "Model", key: "m", contextWindowTokens: 100000 };
const visibility = () => ({
  showToolCalls: false,
  showThinking: false,
  showStatus: false,
  showReasoningSummary: false,
  showContextStats: false,
  showPromptPlan: false,
});

type Sent = { anthropic?: string; bedrock?: unknown };

function adapters(sent: Sent): Record<string, LLMProvider> {
  const anthropic = createProvider({
    name: "anthropic",
    type: "anthropic",
    apiKey: "k",
    models: [model],
    defaultModel: "m",
  });
  const bedrock = createProvider({
    name: "bedrock",
    type: "bedrock",
    region: "us-east-1",
    models: [model],
    defaultModel: "m",
  });
  // The Bedrock adapter sends through an AWS client rather than fetch.
  (bedrock as unknown as { client: { send: unknown } }).client.send =
    async (command: { input: unknown }) => {
      sent.bedrock = command.input;
      throw Object.assign(new Error("stubbed"), {
        name: "ValidationException",
        $metadata: { httpStatusCode: 400 },
      });
    };
  return { anthropic, bedrock };
}

function bedrockImages(input: unknown) {
  const messages = (input as { messages: Array<{ content: unknown[] }> })
    .messages;
  return messages
    .flatMap((message) => message.content)
    .flatMap((block) =>
      (block as { image?: unknown }).image
        ? [
            (
              block as {
                image: { format: string; source: { bytes: Uint8Array } };
              }
            ).image,
          ]
        : [],
    )
    .map((image) => ({
      format: image.format,
      bytes: Buffer.from(image.source.bytes).toString("base64"),
    }));
}

function anthropicImages(body: string) {
  const request = JSON.parse(body) as {
    messages: Array<{ content: Array<{ type: string; source?: unknown }> }>;
  };
  return request.messages
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((block) => block.type === "image")
    .map((block) => block.source);
}

describe("image attachments at the provider boundary", () => {
  let sent: Sent;

  beforeEach(() => {
    sent = {};
    jest.spyOn(globalThis, "fetch").mockImplementation((async (
      _input: unknown,
      init?: { body?: unknown },
    ) => {
      sent.anthropic = String(init?.body);
      return new Response(JSON.stringify({ error: { message: "stubbed" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function runThroughCli(provider: LLMProvider, images: unknown[]) {
    const agent = createTestAgent(provider);
    const turns = createCliTurnSession(
      agent,
      new TerminalUi({
        interactive: false,
        plain: true,
        json: false,
        stdout: createTtyTestStream(),
        stderr: createTtyTestStream(),
      }),
      visibility,
    );
    await turns
      .runTurn(
        { text: "Describe this", images: images as never },
        new AbortController().signal,
      )
      .catch(() => {});
  }

  /** A frontend in another process: the command arrives as JSON text. */
  async function runFromOutside(provider: LLMProvider, bytes: Uint8Array) {
    const agent = createTestAgent(provider);
    const turns = createCliTurnSession(
      agent,
      new TerminalUi({
        interactive: false,
        plain: true,
        json: false,
        stdout: createTtyTestStream(),
        stderr: createTtyTestStream(),
      }),
      visibility,
    );
    const { encodeCommandImage } = await import("../agent-core/index.js");
    const wire = JSON.stringify({
      type: "submit",
      commandId: "remote-1",
      text: "Describe this",
      images: [encodeCommandImage(bytes)],
    });
    turns.session.dispatch(JSON.parse(wire));
    await turns.session.settled();
  }

  it("keeps JPEG bytes from the terminal a JPEG for Anthropic", async () => {
    await runThroughCli(adapters(sent).anthropic!, [JPEG]);
    expect(anthropicImages(sent.anthropic!)).toEqual([
      { type: "base64", media_type: "image/jpeg", data: JPEG_BASE64 },
    ]);
  });

  it("keeps bytes from the terminal an image block for Bedrock", async () => {
    await runThroughCli(adapters(sent).bedrock!, [JPEG]);
    // The adapter's own handling of bytes, unchanged by the session.
    expect(bedrockImages(sent.bedrock)).toEqual([
      { format: "png", bytes: JPEG_BASE64 },
    ]);
  });

  it("delivers a JPEG sent as a command from outside as a JPEG to Anthropic", async () => {
    await runFromOutside(adapters(sent).anthropic!, JPEG);
    expect(anthropicImages(sent.anthropic!)).toEqual([
      { type: "base64", media_type: "image/jpeg", data: JPEG_BASE64 },
    ]);
  });

  it("delivers a JPEG sent as a command from outside to Bedrock", async () => {
    await runFromOutside(adapters(sent).bedrock!, JPEG);
    expect(bedrockImages(sent.bedrock)).toEqual([
      { format: "jpeg", bytes: JPEG_BASE64 },
    ]);
  });
});
