import { execSync } from "child_process";
import { Agent } from "../agent.js";
import { defaultSystemPrompt } from "../defaultSystemPrompt.js";
import { DEFAULT_CORE_IDENTITY } from "../prompt/compileSystemPrompt.js";
import { ChatRequest, LLMProvider, ChatStreamEvent } from "../providers/types.js";
import { testProvidersConfig } from "./testHelpers.js";

class MockProvider implements LLMProvider {
  name = "mock";
  streamChatCalls: ChatRequest[] = [];

  getCapabilities() {
    return { contextWindowTokens: 128000 };
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    this.streamChatCalls.push(request);
    yield { delta: "ok" };
  }
}

function countSectionHeaders(content: string, header: string): number {
  return content.split(header).length - 1;
}

describe("CLI default system prompt", () => {
  it("uses core-only base rules on the default Agent path (no compiled prompt nesting)", async () => {
    const mockProvider = new MockProvider();
    const agent = new Agent({
      providersConfig: testProvidersConfig,
      agentsMdContent: "Run format:check before commit.",
    });
    (agent as unknown as { provider: LLMProvider }).provider = mockProvider;

    expect((agent as unknown as { baseRules: string }).baseRules).toBe(
      DEFAULT_CORE_IDENTITY,
    );
    expect((agent as unknown as { baseRules: string }).baseRules).not.toContain(
      "# Tool Utilization",
    );

    await agent.streamChat("hello", () => {});

    const systemMsg = mockProvider.streamChatCalls[0].messages.find(
      (m) => m.role === "system",
    );
    expect(systemMsg).toBeDefined();
    const content = systemMsg!.content;

    expect(countSectionHeaders(content, "# Tool Utilization")).toBe(1);
    expect(countSectionHeaders(content, "# Runtime Environment")).toBe(1);
    expect(content.indexOf("# Core Identity")).toBeLessThan(
      content.indexOf("# Project Instructions"),
    );
    expect(content).toContain("Run format:check before commit.");
  });

  it("footgun: passing compiled defaultSystemPrompt as systemPrompt double-wraps sections", async () => {
    const mockProvider = new MockProvider();
    const agent = new Agent({
      providersConfig: testProvidersConfig,
      systemPrompt: defaultSystemPrompt,
    });
    (agent as unknown as { provider: LLMProvider }).provider = mockProvider;

    await agent.streamChat("hello", () => {});

    const systemMsg = mockProvider.streamChatCalls[0].messages.find(
      (m) => m.role === "system",
    );
    expect(countSectionHeaders(systemMsg!.content, "# Tool Utilization")).toBe(
      2,
    );
  });
});
