import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent } from "../agent.js";
import type { AgentDiagnosticEvent } from "../diagnostics.js";
import type { LLMProvider } from "../providers/interface.js";
import type { ChatRequest } from "../providers/types.js";
import { clearSandboxEnvForTest, restoreSandboxEnv } from "./envTestHelpers.js";
import {
  testProvidersConfig,
  ToolCallMockProvider,
  userSubmission,
} from "./testHelpers.js";

class SingleShotMockProvider implements LLMProvider {
  name = "mock-single";
  streamChatCalls: ChatRequest[] = [];

  getCapabilities() {
    return { contextWindowTokens: 128000 };
  }

  async *streamChat(request: ChatRequest): AsyncIterable<{ delta: string }> {
    this.streamChatCalls.push(request);
    yield { delta: "ok" };
  }
}

function scratchpadPathFromPrompt(prompt: string): string | undefined {
  const match = prompt.match(/# Scratchpad Directory[\s\S]*?`([^`]+)`/);
  return match?.[1];
}

function agentOptions(cwdDir: string, sessionsDir: string) {
  return {
    providersConfig: testProvidersConfig,
    cwd: cwdDir,
    sessionsDir,
  };
}

describe("Agent scratchpad integration", () => {
  let cwdDir: string;
  let sessionsDir: string;
  let previousSandboxEnv: string | undefined;

  beforeEach(() => {
    cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-agent-cwd-"));
    sessionsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "propio-agent-sessions-"),
    );
    previousSandboxEnv = clearSandboxEnvForTest();
  });

  afterEach(() => {
    restoreSandboxEnv(previousSandboxEnv);
    fs.rmSync(cwdDir, { recursive: true, force: true });
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  function systemPromptFrom(
    provider: { streamChatCalls: ChatRequest[] },
    callIndex = 0,
  ): string {
    const systemMsg = provider.streamChatCalls[callIndex]?.messages.find(
      (m) => m.role === "system",
    );
    return systemMsg?.content ?? "";
  }

  it("includes scratchpadDirectory for resumed sessionId after importSession", async () => {
    const persistedId = "11111111-1111-4111-8111-111111111111";
    const constructorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    const agent1 = new Agent(agentOptions(cwdDir, sessionsDir));
    (agent1 as { sessionId: string }).sessionId = persistedId;

    const json = agent1.exportSession();
    const agent2 = new Agent(agentOptions(cwdDir, sessionsDir));
    (agent2 as { sessionId: string }).sessionId = constructorId;
    agent2.importSession(json);

    const mockProvider = new SingleShotMockProvider();
    (agent2 as { provider: LLMProvider }).provider = mockProvider;

    await agent2.streamChat(userSubmission("hi"), () => {});

    const expectedScratch = path.resolve(
      sessionsDir,
      "scratchpads",
      persistedId,
    );
    const prompt = systemPromptFrom(mockProvider);
    expect(prompt).toContain("# Scratchpad Directory");
    expect(prompt).toContain(expectedScratch);
    expect(prompt).not.toContain(`scratchpads/${constructorId}`);
    expect(fs.existsSync(expectedScratch)).toBe(false);
  });

  it("uses sandbox scratchpad path when IS_SANDBOX", async () => {
    process.env.IS_SANDBOX = "true";
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const agent = new Agent(agentOptions(cwdDir, sessionsDir));
    (agent as { sessionId: string }).sessionId = sessionId;

    const mockProvider = new SingleShotMockProvider();
    (agent as { provider: LLMProvider }).provider = mockProvider;

    await agent.streamChat(userSubmission("hi"), () => {});

    const expected = path.resolve("/tmp", "propio-scratchpads", sessionId);
    const prompt = systemPromptFrom(mockProvider);
    expect(prompt).toContain(expected);
    expect(prompt).not.toContain(sessionsDir);
    fs.rmSync(expected, { recursive: true, force: true });
  });

  it("uses the same scratchpad path across iterations in one turn", async () => {
    const mockProvider = new ToolCallMockProvider("read");
    const agent = new Agent(agentOptions(cwdDir, sessionsDir));
    (agent as { provider: LLMProvider }).provider = mockProvider;

    await agent.streamChat(userSubmission("multi"), () => {});

    expect(mockProvider.streamChatCalls.length).toBeGreaterThanOrEqual(2);
    const firstPath = scratchpadPathFromPrompt(
      systemPromptFrom(mockProvider, 0),
    );
    const secondPath = scratchpadPathFromPrompt(
      systemPromptFrom(mockProvider, 1),
    );
    expect(firstPath).toBeDefined();
    expect(secondPath).toBe(firstPath);
    expect(fs.existsSync(firstPath!)).toBe(false);
  });

  it("omits scratchpad section and emits diagnostic when resolve fails", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const blocked = path.join(sessionsDir, "scratchpads", sessionId);
    fs.mkdirSync(path.dirname(blocked), { recursive: true });
    fs.writeFileSync(blocked, "blocks directory creation");

    const events: AgentDiagnosticEvent[] = [];
    const diagnosticAgent = new Agent({
      ...agentOptions(cwdDir, sessionsDir),
      diagnosticsEnabled: true,
      onDiagnosticEvent: (e) => events.push(e),
    });
    (diagnosticAgent as { sessionId: string }).sessionId = sessionId;

    const mockProvider = new SingleShotMockProvider();
    (diagnosticAgent as { provider: LLMProvider }).provider = mockProvider;

    await diagnosticAgent.streamChat(userSubmission("hi"), () => {});

    expect(
      events.some(
        (e) =>
          e.type === "scratchpad_unavailable" &&
          e.path === blocked &&
          e.errorName.length > 0,
      ),
    ).toBe(true);
    expect(systemPromptFrom(mockProvider)).not.toContain(
      "# Scratchpad Directory",
    );
  });

  it("rejects unsafe imported sessionId and keeps constructor sessionId", async () => {
    const constructorId = "44444444-4444-4444-8444-444444444444";
    const events: AgentDiagnosticEvent[] = [];
    const agent = new Agent({
      ...agentOptions(cwdDir, sessionsDir),
      diagnosticsEnabled: true,
      onDiagnosticEvent: (e) => events.push(e),
    });
    (agent as { sessionId: string }).sessionId = constructorId;

    const malicious = JSON.parse(agent.exportSession()) as {
      metadata: { sessionId: string };
    };
    malicious.metadata.sessionId = "../../outside";
    agent.importSession(JSON.stringify(malicious));

    expect((agent as { sessionId: string }).sessionId).toBe(constructorId);
    expect(
      events.some(
        (e) =>
          e.type === "invalid_session_id" && e.sessionId === "../../outside",
      ),
    ).toBe(true);
  });
});
