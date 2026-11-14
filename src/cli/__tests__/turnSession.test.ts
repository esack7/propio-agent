import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { Agent } from "../../agent.js";
import type { GuidanceSource } from "../../agent-core/index.js";
import type { ApprovalChannel } from "../../permissions/approvalChannel.js";
import type { ApprovalAnswer, ApprovalRequest } from "../../policy/index.js";
import { createApprovalPromptChannel } from "../../ui/approvalPrompt.js";
import { TerminalUi } from "../../ui/terminal.js";
import { createTtyTestStream } from "../../ui/__tests__/ttyTestStream.js";
import {
  createTestAgent,
  ToolCallMockProvider,
} from "../../__tests__/testHelpers.js";
import {
  answerApprovalsThrough,
  createCliTurnSession,
} from "../turnSession.js";

const visibility = () => ({
  showToolCalls: true,
  showThinking: false,
  showStatus: false,
  showReasoningSummary: false,
  showContextStats: false,
  showPromptPlan: false,
});

function createUi(): TerminalUi {
  return new TerminalUi({
    interactive: false,
    plain: true,
    json: false,
    stdout: createTtyTestStream(),
    stderr: createTtyTestStream(),
  });
}

interface StreamCall {
  submission: unknown;
  signal: AbortSignal | undefined;
  guidance: GuidanceSource | undefined;
}

/** An agent whose turn stays open until the test settles it. */
function heldAgent() {
  const calls: StreamCall[] = [];
  let settle!: { resolve(text: string): void; reject(error: unknown): void };
  const agent = {
    streamChat: (
      submission: unknown,
      _onToken: unknown,
      options?: { abortSignal?: AbortSignal; guidance?: GuidanceSource },
    ) => {
      calls.push({
        submission,
        signal: options?.abortSignal,
        guidance: options?.guidance,
      });
      return new Promise<string>((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    getLastTurnReasoningSummary: () => null,
    getConversationState: () => ({ turns: [], artifacts: [] }),
  } as unknown as Agent;
  return { agent, calls, settle: () => settle };
}

const request = (id: string): ApprovalRequest => ({
  id,
  toolName: "bash",
  args: {},
  capabilities: ["process"],
  reason: "mode default",
  rule: "mode:ask",
  suggestions: [],
});

describe("the CLI's turn session", () => {
  it("submits through a command that carries only text and image strings", async () => {
    const { agent, calls, settle } = heldAgent();
    const turns = createCliTurnSession(agent, createUi(), visibility);
    const commands: string[] = [];
    turns.session.subscribe((event) => commands.push(event.type));

    const pending = turns.runTurn(
      {
        text: "Describe these",
        displayText: "[Image #1] [Image #2]",
        inputMode: "prompt",
        images: ["data:image/png;base64,aGk=", new Uint8Array([104, 105])],
      } as never,
      new AbortController().signal,
    );
    settle().resolve("Two images.");

    await expect(pending).resolves.toMatchObject({ response: "Two images." });
    expect(calls).toHaveLength(1);
    // Display state stays in the terminal; bytes travel as base64.
    expect(calls[0]!.submission).toEqual({
      text: "Describe these",
      images: ["data:image/png;base64,aGk=", "aGk="],
    });
    expect(commands).toEqual(["session_turn_started", "session_turn_ended"]);
  });

  it("turns an abort into an interrupt command and rejects with the turn's own error", async () => {
    const { agent, calls, settle } = heldAgent();
    const turns = createCliTurnSession(agent, createUi(), visibility);
    const controller = new AbortController();
    const pending = turns.runTurn({ text: "Go" }, controller.signal);

    controller.abort("escape");
    // The turn was told by the session, with the session's reason.
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls[0]!.signal?.reason).toBe("interrupt");
    const cancelled = new Error("Request cancelled");
    settle().reject(cancelled);

    await expect(pending).rejects.toBe(cancelled);
    expect(turns.session.running).toBe(false);
  });

  it("rejects with the turn's own error when the turn fails", async () => {
    const { agent, settle } = heldAgent();
    const turns = createCliTurnSession(agent, createUi(), visibility);
    const pending = turns.runTurn({ text: "Go" }, new AbortController().signal);
    const failure = new TypeError("provider unavailable");
    settle().reject(failure);
    await expect(pending).rejects.toBe(failure);
  });

  it("does not start a turn for a signal that is already aborted", async () => {
    const { agent, calls } = heldAgent();
    const turns = createCliTurnSession(agent, createUi(), visibility);
    const controller = new AbortController();
    controller.abort("escape");
    await expect(
      turns.runTurn({ text: "Go" }, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(calls).toHaveLength(0);
  });

  it("runs one turn after another on the same session", async () => {
    const { agent, calls, settle } = heldAgent();
    const turns = createCliTurnSession(agent, createUi(), visibility);
    const first = turns.runTurn({ text: "One" }, new AbortController().signal);
    settle().resolve("First.");
    await first;
    const second = turns.runTurn({ text: "Two" }, new AbortController().signal);
    settle().resolve("Second.");
    await expect(second).resolves.toMatchObject({ response: "Second." });
    expect(calls.map((call) => call.submission)).toEqual([
      { text: "One" },
      { text: "Two" },
    ]);
  });

  it("gives the running turn guidance dispatched to the session", async () => {
    const { agent, calls, settle } = heldAgent();
    const turns = createCliTurnSession(agent, createUi(), visibility);
    const pending = turns.runTurn({ text: "Go" }, new AbortController().signal);

    expect(
      turns.session.dispatch({
        type: "guide",
        commandId: "g1",
        text: "Faster",
      }),
    ).toMatchObject({ accepted: true });
    expect(calls[0]!.guidance?.drain()).toEqual([{ id: "g1", text: "Faster" }]);

    settle().resolve("Done.");
    await pending;
  });
});

describe("answering approvals through the session", () => {
  function setup(reply: ApprovalChannel["request"]) {
    const { agent, settle } = heldAgent();
    const turns = createCliTurnSession(agent, createUi(), visibility);
    const asked: Array<{ request: ApprovalRequest; signal?: AbortSignal }> = [];
    answerApprovalsThrough(turns.session, {
      request: (approval, signal) => {
        asked.push({ request: approval, signal });
        return reply(approval, signal);
      },
    });
    const controller = new AbortController();
    const turn = turns.runTurn({ text: "Go" }, controller.signal);
    turn.catch(() => {});
    const finish = async () => {
      settle().resolve("Done.");
      await turns.session.settled();
    };
    return { turns, asked, controller, settle, finish };
  }

  it("asks the channel and returns its answer as a command", async () => {
    const { turns, asked, finish } = setup(async (approval) => ({
      requestId: approval.id,
      decision: "allow_session",
      rule: "bash",
    }));
    const resolved: unknown[] = [];
    turns.session.subscribe((event) => {
      if (event.type === "approval_resolved") resolved.push(event);
    });

    await expect(
      turns.session.approvalChannel.request(request("r1")),
    ).resolves.toEqual({
      requestId: "r1",
      decision: "allow_session",
      rule: "bash",
    });
    expect(asked.map((entry) => entry.request.id)).toEqual(["r1"]);
    expect(resolved).toEqual([
      {
        type: "approval_resolved",
        requestId: "r1",
        resolution: "allow_session",
      },
    ]);
    await finish();
  });

  it("closes the prompt and sends no answer when the turn is interrupted", async () => {
    let answerLate!: (answer: ApprovalAnswer) => void;
    const { turns, asked, controller, settle } = setup(
      (approval) =>
        new Promise<ApprovalAnswer>((resolve) => {
          answerLate = resolve;
          void approval;
        }),
    );
    const answer = turns.session.approvalChannel.request(request("r1"));
    const outcome = answer.then(
      () => "answered",
      (error: Error) => error.message,
    );
    const answers: unknown[] = [];
    turns.session.subscribe((event) => {
      if (event.type === "approval_resolved") answers.push(event.resolution);
    });

    controller.abort("escape");

    expect(await outcome).toMatch(/cancelled/);
    // The prompt was told to close.
    expect(asked[0]!.signal?.aborted).toBe(true);
    // What the prompt returns after being closed is not sent anywhere.
    answerLate({ requestId: "r1", decision: "allow_once" });
    await Promise.resolve();
    expect(answers).toEqual(["withdrawn"]);
    settle().reject(new Error("Request cancelled"));
    await turns.session.settled();
  });

  it("denies when the prompt fails", async () => {
    const { turns, finish } = setup(async () => {
      throw new Error("terminal closed");
    });
    await expect(
      turns.session.approvalChannel.request(request("r1")),
    ).resolves.toEqual({
      requestId: "r1",
      decision: "deny",
      reason: "The approval prompt failed: terminal closed",
    });
    await finish();
  });

  it("denies when the prompt answers a different request", async () => {
    const { turns, finish } = setup(async () => ({
      requestId: "something-else",
      decision: "allow_once",
    }));
    await expect(
      turns.session.approvalChannel.request(request("r1")),
    ).resolves.toMatchObject({ requestId: "r1", decision: "deny" });
    await finish();
  });
});

describe("a real turn approved from the terminal prompt, through commands", () => {
  let workspace: string;
  let cwdSpy: jest.SpiedFunction<typeof process.cwd>;

  beforeEach(() => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "propio-turn-session-")),
    );
    fs.writeFileSync(path.join(workspace, "notes.txt"), "original");
    cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(workspace);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const notes = () =>
    fs.readFileSync(path.join(workspace, "notes.txt"), "utf8");

  it.each([
    ["y", "changed", "allow_once"],
    ["n", "original", "deny"],
  ])(
    "the operator's %s leaves the file %s",
    async (line, expected, resolution) => {
      const provider = new ToolCallMockProvider("write", {
        path: "notes.txt",
        content: "changed",
      });
      // As the CLI builds it: ask mode, no channel until the session's is set.
      const agent = createTestAgent(provider, { permissions: undefined });
      const turns = createCliTurnSession(agent, createUi(), visibility);
      agent.setApprovalChannel(turns.session.approvalChannel, "application");
      const questions: string[] = [];
      answerApprovalsThrough(
        turns.session,
        createApprovalPromptChannel({
          show: () => {},
          readLine: async (text) => {
            questions.push(text);
            return line;
          },
        }),
      );
      const resolutions: unknown[] = [];
      turns.session.subscribe((event) => {
        if (event.type === "approval_resolved")
          resolutions.push(event.resolution);
      });

      await turns.runTurn(
        { text: "Change the notes" },
        new AbortController().signal,
      );

      expect(questions.length).toBeGreaterThan(0);
      expect(resolutions).toEqual([resolution]);
      expect(notes()).toBe(expected);
      // Either way the model was told and the turn finished.
      expect(provider.streamChatCalls).toHaveLength(2);
    },
  );
});
