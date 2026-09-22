import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatRequest, LLMProvider } from "@propio-ai/providers";
import {
  createMockTool,
  createTestAgent,
  ToolCallMockProvider,
} from "./testHelpers.js";
import { userSubmission } from "./testHelpers.js";
import type { AgentTraceRunFactory } from "../agent.js";
import { writeRecoveryCheckpoint } from "../sessions/sessionHistory.js";

const silentTrace: AgentTraceRunFactory = (identity) => ({
  recorder: { identity, record: () => {} },
});

describe("recovery checkpoint lifecycle", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "propio-recovery-behavior-"),
    );
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("retires the outgoing checkpoint after importing another session", async () => {
    const agent = createTestAgent(new ToolCallMockProvider("fixture_tool"), {
      sessionsDir,
      createTraceRun: silentTrace,
    });
    agent.addTool(createMockTool({ name: "fixture_tool" }));
    await agent.streamChat(userSubmission("Run a tool"), () => {});
    const outgoing = JSON.parse(agent.exportSession());
    const outgoingId = outgoing.metadata.sessionId as string;
    const outgoingPath = path.join(sessionsDir, `recovery-${outgoingId}.json`);
    expect(fs.existsSync(outgoingPath)).toBe(true);

    outgoing.metadata.sessionId = "22222222-2222-4222-8222-222222222222";
    agent.importSession(JSON.stringify(outgoing));

    expect(fs.existsSync(outgoingPath)).toBe(false);
  });

  it("does not report cleared tool calls as unresolved on the next run", async () => {
    const events: string[] = [];
    const trace: AgentTraceRunFactory = (identity) => ({
      recorder: { identity, record: (event) => events.push(event.type) },
    });
    const provider: LLMProvider = {
      name: "fixture",
      getCapabilities: () => ({ contextWindowTokens: 128_000 }),
      async *streamChat() {
        yield { delta: "done" };
      },
    };
    const agent = createTestAgent(provider, {
      sessionsDir,
      createTraceRun: trace,
    });
    const snapshot = JSON.parse(agent.exportSession());
    snapshot.metadata.recoveryCheckpoint = true;
    snapshot.context.turns = [
      {
        id: "turn-1",
        startedAt: new Date().toISOString(),
        importance: "normal",
        userMessage: { role: "user", content: "Do work" },
        entries: [
          {
            kind: "assistant",
            createdAt: new Date().toISOString(),
            message: {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "pending",
                  function: { name: "fixture_tool", arguments: {} },
                },
              ],
            },
          },
        ],
      },
    ];
    writeRecoveryCheckpoint(sessionsDir, JSON.stringify(snapshot));
    const checkpointPath = path.join(
      sessionsDir,
      `recovery-${snapshot.metadata.sessionId}.json`,
    );
    agent.importSession(JSON.stringify(snapshot));
    agent.clearContext();

    expect(fs.existsSync(checkpointPath)).toBe(false);

    await agent.streamChat(userSubmission("New task"), () => {});

    expect(events).not.toContain("recovered_tool_call_unresolved");
  });

  it("still checkpoints when trace-run creation fails", async () => {
    const agent = createTestAgent(new ToolCallMockProvider("fixture_tool"), {
      sessionsDir,
      createTraceRun: () => {
        throw new Error("trace unavailable");
      },
    });
    agent.addTool(createMockTool({ name: "fixture_tool" }));

    await agent.streamChat(userSubmission("Run a tool"), () => {});

    expect(fs.readdirSync(sessionsDir)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^recovery-.*\.json$/)]),
    );
  });

  it("does not enable checkpoint storage for an embedder without tracing", async () => {
    const agent = createTestAgent(new ToolCallMockProvider("fixture_tool"), {
      sessionsDir,
    });
    agent.addTool(createMockTool({ name: "fixture_tool" }));

    await agent.streamChat(userSubmission("Run a tool"), () => {});

    expect(fs.readdirSync(sessionsDir)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^recovery-.*\.json$/)]),
    );
  });

  it("continues the tool batch when checkpoint and diagnostic sinks fail", async () => {
    const executed: string[] = [];
    let requests = 0;
    const provider: LLMProvider = {
      name: "fixture",
      getCapabilities: () => ({ contextWindowTokens: 128_000 }),
      async *streamChat(_request: ChatRequest) {
        if (requests++ === 0) {
          yield {
            type: "tool_calls",
            toolCalls: ["first", "second"].map((key, index) => ({
              id: `call-${index + 1}`,
              function: { name: "fixture_tool", arguments: { key } },
            })),
          };
        } else {
          yield { delta: "done" };
        }
      },
    };
    const agent = createTestAgent(provider, {
      sessionsDir,
      createTraceRun: silentTrace,
      diagnosticsEnabled: true,
      onDiagnosticEvent: (event) => {
        if (event.type === "recovery_checkpoint_failed") {
          throw new Error("diagnostic sink failed");
        }
      },
      onRecoveryCheckpointFailure: () => {
        throw new Error("warning sink failed");
      },
    });
    agent.addTool(
      createMockTool({
        name: "fixture_tool",
        execute: async (args) => {
          executed.push(String(args.key));
          return "completed";
        },
      }),
    );
    agent.exportSession = () => {
      throw new Error("checkpoint storage unavailable");
    };

    await expect(
      agent.streamChat(userSubmission("Run both"), () => {}),
    ).resolves.toBe("done");
    expect(executed).toEqual(["first", "second"]);
  });
});
