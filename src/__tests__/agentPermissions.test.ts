import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatRequest } from "@propio-ai/providers";
import { Agent } from "../agent.js";
import type { ApprovalChannel } from "../permissions/approvalChannel.js";
import type { ApprovalAnswer, ApprovalRequest } from "../policy/index.js";
import {
  createMockTool,
  createTestAgent,
  testProvidersConfig,
  ToolCallMockProvider,
  userSubmission,
} from "./testHelpers.js";

type Reply = (request: ApprovalRequest) => ApprovalAnswer;

const allowOnce: Reply = (request) => ({
  requestId: request.id,
  decision: "allow_once",
});
const deny: Reply = (request) => ({ requestId: request.id, decision: "deny" });
const allowToolForSession: Reply = (request) => ({
  requestId: request.id,
  decision: "allow_session",
  rule: request.toolName,
});

function channel(reply: Reply): ApprovalChannel & {
  requests: ApprovalRequest[];
} {
  const requests: ApprovalRequest[] = [];
  return {
    requests,
    request: async (request) => {
      requests.push(request);
      return reply(request);
    },
  };
}

interface PolicyEvent {
  toolName: string;
  decision: string;
  actor: string;
  rule: string;
  reason?: string;
}

function toolResult(request: ChatRequest | undefined): string {
  const message = request?.messages.find((m) => m.role === "tool");
  return message?.toolResults?.[0]?.content ?? "";
}

describe("tool permissions in the agent", () => {
  let workspace: string;
  let sessionsDir: string;
  let cwdSpy: jest.SpiedFunction<typeof process.cwd>;

  beforeEach(() => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "propio-permissions-")),
    );
    workspace = path.join(root, "workspace");
    sessionsDir = path.join(root, "sessions");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "notes.txt"), "original");
    cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(workspace);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
  });

  /** An agent as the CLI builds it: no permissions configured. */
  function agentFor(
    provider: ToolCallMockProvider,
    options: Partial<ConstructorParameters<typeof Agent>[0]> = {},
  ): { agent: Agent; policyEvents: PolicyEvent[] } {
    const policyEvents: PolicyEvent[] = [];
    const agent = createTestAgent(provider, {
      permissions: undefined,
      sessionsDir,
      createTraceRun: (identity) => ({
        recorder: {
          identity,
          record: (event) => {
            if (event.type === "tool_policy_decision") {
              policyEvents.push(event.payload as PolicyEvent);
            }
          },
        },
      }),
      ...options,
    });
    return { agent, policyEvents };
  }

  const write = () =>
    new ToolCallMockProvider("write", {
      path: "notes.txt",
      content: "changed",
    });
  const notes = () =>
    fs.readFileSync(path.join(workspace, "notes.txt"), "utf8");

  it("starts in ask mode with nothing configured, so a write does not run unasked (a6)", async () => {
    const provider = write();
    const agent = new Agent({ providersConfig: testProvidersConfig });
    (agent as unknown as { provider: unknown }).provider = provider;

    await agent.streamChat(userSubmission("Change the notes"), () => {});

    expect(notes()).toBe("original");
    expect(toolResult(provider.streamChatCalls[1])).toContain(
      "Workspace writes need approval in ask mode",
    );
  });

  it("asks before a write and runs it only when approved (a2)", async () => {
    const approving = channel(allowOnce);
    const { agent } = agentFor(write(), {
      permissions: { approvalChannel: approving },
    });

    await agent.streamChat(userSubmission("Change the notes"), () => {});

    expect(approving.requests).toHaveLength(1);
    expect(approving.requests[0]).toMatchObject({
      toolName: "write",
      toolCallId: "call-write-1",
      sessionId: JSON.parse(agent.exportSession()).metadata.sessionId,
      target: { kind: "path", path: path.join(workspace, "notes.txt") },
    });
    expect(notes()).toBe("changed");
  });

  it("asks before running a command (a2)", async () => {
    const marker = path.join(workspace, "ran.txt");
    const provider = new ToolCallMockProvider("bash", {
      command: "echo ran > ran.txt",
      cwd: workspace,
    });
    const refusing = channel(deny);
    const { agent } = agentFor(provider, {
      permissions: { approvalChannel: refusing },
    });

    await agent.streamChat(userSubmission("Run it"), () => {});

    expect(refusing.requests).toHaveLength(1);
    expect(refusing.requests[0]?.target).toEqual({
      kind: "command",
      command: "echo ran > ran.txt",
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("asks before a tool that declares nothing, as every MCP tool does (a2)", async () => {
    const ran = jest.fn(async () => "done");
    const refusing = channel(deny);
    const { agent } = agentFor(new ToolCallMockProvider("undeclared"), {
      permissions: { approvalChannel: refusing },
    });
    agent.addTool(createMockTool({ name: "undeclared", execute: ran }));

    await agent.streamChat(userSubmission("Use it"), () => {});

    expect(refusing.requests[0]?.capabilities).toEqual(["external"]);
    expect(ran).not.toHaveBeenCalled();
  });

  it("reads inside the workspace without asking (a2)", async () => {
    const provider = new ToolCallMockProvider("read", { path: "notes.txt" });
    const refusing = channel(deny);
    const { agent, policyEvents } = agentFor(provider, {
      permissions: { approvalChannel: refusing },
    });

    await agent.streamChat(userSubmission("Read the notes"), () => {});

    expect(refusing.requests).toHaveLength(0);
    expect(toolResult(provider.streamChatCalls[1])).toContain("original");
    expect(policyEvents.at(-1)).toMatchObject({
      decision: "allowed",
      actor: "application",
      rule: "mode:ask",
    });
  });

  it("returns a denial to the model as a tool result and continues the turn (a3)", async () => {
    const provider = write();
    const { agent } = agentFor(provider, {
      permissions: {
        approvalChannel: channel((request) => ({
          requestId: request.id,
          decision: "deny",
          reason: "leave the notes alone",
        })),
      },
    });
    const ended: unknown[][] = [];

    const response = await agent.streamChat(
      userSubmission("Change the notes"),
      () => {},
      { onToolEnd: (...args: unknown[]) => ended.push(args) },
    );

    expect(notes()).toBe("original");
    expect(provider.streamChatCalls).toHaveLength(2);
    expect(toolResult(provider.streamChatCalls[1])).toBe(
      "Permission denied for write: leave the notes alone",
    );
    expect(response).toBe("Final answer after write.");
    expect(ended).toEqual([
      [
        "write",
        "Permission denied for write: leave the notes alone",
        "tool_disabled",
      ],
    ]);
  });

  it("never waits for an answer when there is no one to ask (a8)", async () => {
    const provider = write();
    const { agent, policyEvents } = agentFor(provider);

    const response = await agent.streamChat(
      userSubmission("Change the notes"),
      () => {},
    );

    expect(response).toBe("Final answer after write.");
    expect(notes()).toBe("original");
    expect(toolResult(provider.streamChatCalls[1])).toContain(
      "not available in non-interactive mode",
    );
    expect(policyEvents.at(-1)).toMatchObject({
      decision: "denied",
      actor: "application",
      rule: "non_interactive",
    });
  });

  it("records each decision in the trace with its rule and actor (a9)", async () => {
    const approved = agentFor(write(), {
      permissions: { approvalChannel: channel(allowOnce) },
    });
    const refused = agentFor(write(), {
      permissions: { approvalChannel: channel(deny) },
    });
    const bypassed = agentFor(write(), { permissions: { preset: "bypass" } });

    for (const { agent } of [approved, refused, bypassed]) {
      await agent.streamChat(userSubmission("Change the notes"), () => {});
    }

    expect(approved.policyEvents).toEqual([
      expect.objectContaining({ rule: "tool_scope", actor: "agent" }),
      expect.objectContaining({
        toolName: "write",
        decision: "allowed",
        actor: "user",
        rule: "approval:allow_once",
        reason: "Allowed once",
      }),
    ]);
    expect(refused.policyEvents.at(-1)).toMatchObject({
      decision: "denied",
      actor: "user",
      rule: "approval:deny",
    });
    expect(bypassed.policyEvents.at(-1)).toMatchObject({
      decision: "allowed",
      actor: "application",
      rule: "mode:bypass",
    });
  });

  it("records a failed approval as an error and does not run the call", async () => {
    const provider = write();
    const { agent, policyEvents } = agentFor(provider, {
      permissions: {
        approvalChannel: {
          request: async () => {
            throw new Error("terminal went away");
          },
        },
      },
    });

    await agent.streamChat(userSubmission("Change the notes"), () => {});

    expect(notes()).toBe("original");
    expect(toolResult(provider.streamChatCalls[1])).toBe(
      "Tool policy evaluation failed: terminal went away",
    );
    expect(policyEvents.at(-1)).toMatchObject({
      decision: "error",
      rule: "authorization_callback",
    });
  });

  it("cancels the turn when it is stopped while a question is open", async () => {
    const controller = new AbortController();
    let signalSeen: AbortSignal | undefined;
    const { agent } = agentFor(write(), {
      permissions: {
        approvalChannel: {
          request: (_request, signal) =>
            new Promise<ApprovalAnswer>(() => {
              signalSeen = signal;
              controller.abort("escape");
            }),
        },
      },
    });

    await expect(
      agent.streamChat(userSubmission("Change the notes"), () => {}, {
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();

    expect(signalSeen?.aborted).toBe(true);
    expect(notes()).toBe("original");
  });

  it("reports an unknown tool as not found instead of asking about it", async () => {
    const provider = new ToolCallMockProvider("no_such_tool");
    const refusing = channel(deny);
    const { agent } = agentFor(provider, {
      permissions: { approvalChannel: refusing },
    });

    await agent.streamChat(userSubmission("Use it"), () => {});

    expect(refusing.requests).toHaveLength(0);
    expect(toolResult(provider.streamChatCalls[1])).toContain(
      "Tool not found: no_such_tool",
    );
  });

  describe("session approvals (a5)", () => {
    it("stop further prompts, are saved with the session, and return on resume only", async () => {
      const approving = channel(allowToolForSession);
      const first = agentFor(write(), {
        permissions: { approvalChannel: approving },
      });
      await first.agent.streamChat(userSubmission("Change"), () => {});
      (first.agent as unknown as { provider: unknown }).provider = write();
      await first.agent.streamChat(userSubmission("Again"), () => {});
      expect(approving.requests).toHaveLength(1);
      expect(first.policyEvents.at(-1)).toMatchObject({
        actor: "application",
        rule: "session_grant:write",
      });

      const snapshot = first.agent.exportSession();
      expect(JSON.parse(snapshot).metadata.sessionGrants).toEqual(["write"]);

      // Resumed in a new process: the approval is still in force.
      const resumedChannel = channel(deny);
      const resumed = agentFor(write(), {
        permissions: { approvalChannel: resumedChannel },
      });
      resumed.agent.importSession(snapshot);
      fs.writeFileSync(path.join(workspace, "notes.txt"), "original");
      await resumed.agent.streamChat(userSubmission("Change"), () => {});
      expect(resumedChannel.requests).toHaveLength(0);
      expect(notes()).toBe("changed");

      // A new session asks again.
      const freshChannel = channel(deny);
      const fresh = agentFor(write(), {
        permissions: { approvalChannel: freshChannel },
      });
      fs.writeFileSync(path.join(workspace, "notes.txt"), "original");
      await fresh.agent.streamChat(userSubmission("Change"), () => {});
      expect(freshChannel.requests).toHaveLength(1);
      expect(notes()).toBe("original");
      expect(
        JSON.parse(fresh.agent.exportSession()).metadata,
      ).not.toHaveProperty("sessionGrants");
    });

    it("are dropped when a session without them is resumed", async () => {
      const plain = agentFor(write()).agent.exportSession();
      const approving = channel(allowToolForSession);
      const { agent } = agentFor(write(), {
        permissions: { approvalChannel: approving },
      });
      await agent.streamChat(userSubmission("Change"), () => {});

      agent.importSession(plain);
      (agent as unknown as { provider: unknown }).provider = write();
      await agent.streamChat(userSubmission("Again"), () => {});

      expect(approving.requests).toHaveLength(2);
    });

    it("refuse a snapshot whose approvals cannot be read, leaving the session as it was", () => {
      const { agent } = agentFor(write());
      const sessionId = JSON.parse(agent.exportSession()).metadata.sessionId;
      const snapshot = JSON.parse(agent.exportSession());
      snapshot.metadata.sessionId = "11111111-1111-4111-8111-111111111111";

      snapshot.metadata.sessionGrants = ["bash("];
      expect(() => agent.importSession(JSON.stringify(snapshot))).toThrow(
        /Invalid permission rule/,
      );
      snapshot.metadata.sessionGrants = "bash";
      expect(() => agent.importSession(JSON.stringify(snapshot))).toThrow(
        /sessionGrants/,
      );
      expect(JSON.parse(agent.exportSession()).metadata.sessionId).toBe(
        sessionId,
      );
    });
  });

  describe("plan and discover modes", () => {
    it("run a read-only command without a prompt, and still refuse what the mode refuses", async () => {
      const refusing = channel(deny);
      const readOnly = agentFor(
        new ToolCallMockProvider("bash", { command: "git status" }),
        { permissions: { approvalChannel: refusing } },
      );
      const mutating = agentFor(
        new ToolCallMockProvider("bash", { command: "rm -rf build" }),
        { permissions: { preset: "bypass" } },
      );
      readOnly.agent.setAgentMode("discover");
      mutating.agent.setAgentMode("discover");

      await readOnly.agent.streamChat(userSubmission("Status"), () => {});
      await mutating.agent.streamChat(userSubmission("Clean"), () => {});

      expect(refusing.requests).toHaveLength(0);
      expect(readOnly.policyEvents.at(-1)).toMatchObject({
        decision: "allowed",
        actor: "application",
        rule: "agent_mode:discover",
      });
      // The mode's own denial stands even in bypass.
      expect(mutating.policyEvents.at(-1)).toMatchObject({
        decision: "denied",
        rule: "mode_bash_policy",
      });
    });
  });
});
