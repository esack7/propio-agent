import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  LLMProvider,
  ProviderCapabilities,
} from "@propio-ai/providers";
import { createTestAgent, userSubmission } from "./testHelpers.js";

class CapabilityMockProvider implements LLMProvider {
  readonly name = "mock-capability";
  readonly streamChatCalls: ChatRequest[] = [];

  constructor(
    private readonly supportsSyntheticToolCallHistory: boolean | undefined,
  ) {}

  getCapabilities(): ProviderCapabilities {
    return {
      contextWindowTokens: 128_000,
      ...(this.supportsSyntheticToolCallHistory === undefined
        ? {}
        : {
            supportsSyntheticToolCallHistory:
              this.supportsSyntheticToolCallHistory,
          }),
    };
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    this.streamChatCalls.push(request);
    yield { delta: "done" };
  }
}

describe("Agent synthetic mention handling per provider capability", () => {
  let workspaceRoot: string;
  let sessionsDir: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "propio-synthetic-mention-"),
    );
    sessionsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "propio-synthetic-mention-sessions-"),
    );
    fs.writeFileSync(path.join(workspaceRoot, "info.txt"), "alpha\nbeta");
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  function mentionToolCallMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.filter((message) =>
      (message.toolCalls ?? []).some((toolCall) =>
        toolCall.id?.startsWith("mention_"),
      ),
    );
  }

  async function streamMentionTurn(
    supportsSyntheticToolCallHistory: boolean | undefined,
  ): Promise<{ provider: CapabilityMockProvider; messages: ChatMessage[] }> {
    const provider = new CapabilityMockProvider(
      supportsSyntheticToolCallHistory,
    );
    const agent = createTestAgent(provider, {
      cwd: workspaceRoot,
      sessionsDir,
    });

    await agent.streamChat(userSubmission("@info.txt summarize"), () => {});

    expect(provider.streamChatCalls.length).toBeGreaterThan(0);
    return { provider, messages: provider.streamChatCalls[0].messages };
  }

  it("inlines mention pairs when the provider rejects synthetic tool-call history", async () => {
    const { messages } = await streamMentionTurn(false);

    expect(mentionToolCallMessages(messages)).toHaveLength(0);
    const inlined = messages.find(
      (message) =>
        message.role === "user" &&
        message.content.includes('mention_id="mention_1"'),
    );
    expect(inlined).toBeDefined();
    expect(inlined?.content).toContain("alpha");
  });

  it("keeps mention tool-call pairs for providers that support synthetic history", async () => {
    const { messages } = await streamMentionTurn(undefined);

    expect(mentionToolCallMessages(messages).length).toBeGreaterThan(0);
  });
});
