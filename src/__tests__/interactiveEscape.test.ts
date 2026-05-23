import { PassThrough } from "stream";
import type { Agent } from "../agent.js";
import { runInteractiveTurn } from "../index.js";
import {
  createAbortStateController,
  type AbortStateController,
} from "../ui/abortState.js";
import type { PromptComposer } from "../ui/promptComposer.js";
import {
  createTtyInputStream,
  withKeypressEvents,
} from "../ui/__tests__/ttyTestStream.js";
import { TerminalUi } from "../ui/terminal.js";
import { createMockWriteStream } from "./testHelpers.js";

const emptyConversationState = {
  preamble: [],
  turns: [],
  artifacts: [],
  pinnedMemory: [],
  invokedSkills: [],
  rollingSummary: null,
};

const rejectingStreamChat: Agent["streamChat"] = async (
  _userMessage,
  _onToken,
  options,
) => {
  if (options?.abortSignal?.aborted) {
    throw new Error("Request cancelled");
  }
  return "done";
};

function createGatedAgent(streamChat: Agent["streamChat"]): {
  agent: Agent;
  releaseStream: () => void;
} {
  let releaseStream!: () => void;
  const streamGate = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });

  const agent = {
    async streamChat(
      userMessage: string,
      onToken: (token: string) => void,
      options?: { abortSignal?: AbortSignal },
    ): Promise<string> {
      await streamGate;
      return streamChat(userMessage, onToken, options);
    },
    getLastTurnReasoningSummary: () => null,
    getConversationState: () => emptyConversationState,
  } as unknown as Agent;

  return { agent, releaseStream };
}

function emitEscapeAndRelease(ctx: {
  inputStream: PassThrough;
  releaseStream: () => void;
}): void {
  ctx.inputStream.emit("keypress", "\u001b", { name: "escape" });
  ctx.releaseStream();
}

async function runGatedInteractiveTurn(
  streamChat: Agent["streamChat"],
  trigger: (ctx: {
    abortState: AbortStateController;
    inputStream: PassThrough;
    releaseStream: () => void;
  }) => void,
): Promise<{
  turnPromise: Promise<number | null>;
  abortState: AbortStateController;
  ui: { warn: jest.Mock; setMode: jest.Mock };
}> {
  const ui = { warn: jest.fn(), setMode: jest.fn() };
  const abortState = createAbortStateController(ui as never);
  const inputStream = withKeypressEvents(createTtyInputStream());
  const { agent, releaseStream } = createGatedAgent(streamChat);
  const stdout = createMockWriteStream();
  const stderr = createMockWriteStream();
  const terminalUi = new TerminalUi({
    interactive: true,
    plain: true,
    json: false,
    stdout,
    stderr,
  });

  const turnPromise = runInteractiveTurn(
    "hello",
    {
      agent,
      ui: terminalUi,
      composer: {} as PromptComposer,
      configPath: "/tmp/providers.json",
      inputStream: inputStream as unknown as NodeJS.ReadStream,
      interactiveInput: true,
      setCurrentAbortController: abortState.setCurrentAbortController,
      cancelActiveTurn: abortState.cancelActiveTurn,
      shouldExit: abortState.shouldExit,
      getVisibility: () => ({
        showToolCalls: true,
        showThinking: false,
        showStatus: false,
        showReasoningSummary: false,
        showContextStats: false,
        showPromptPlan: false,
      }),
    },
    { errorPrefix: "Error: " },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  trigger({ abortState, inputStream, releaseStream });

  return { turnPromise, abortState, ui };
}

describe("interactive escape cancel", () => {
  it("returns null from runInteractiveTurn so the REPL can continue", async () => {
    const { turnPromise, abortState, ui } = await runGatedInteractiveTurn(
      rejectingStreamChat,
      emitEscapeAndRelease,
    );

    await expect(turnPromise).resolves.toBeNull();
    expect(abortState.shouldExit()).toBe(false);
    expect(ui.warn).toHaveBeenCalledWith("Turn cancelled.");
  });

  it("returns 130 from runInteractiveTurn when SIGINT sets shouldExit", async () => {
    const { turnPromise, abortState } = await runGatedInteractiveTurn(
      rejectingStreamChat,
      ({ abortState, releaseStream }) => {
        abortState.handleSigint();
        releaseStream();
      },
    );

    await expect(turnPromise).resolves.toBe(130);
    expect(abortState.shouldExit()).toBe(true);
  });

  it("does not call turnComplete when the stream resolves normally after escape abort", async () => {
    const turnCompleteSpy = jest.spyOn(TerminalUi.prototype, "turnComplete");
    const { turnPromise } = await runGatedInteractiveTurn(
      async () => "late response",
      emitEscapeAndRelease,
    );

    await expect(turnPromise).resolves.toBeNull();
    expect(turnCompleteSpy).not.toHaveBeenCalled();
    turnCompleteSpy.mockRestore();
  });
});
