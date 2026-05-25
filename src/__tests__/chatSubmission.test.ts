import type { Agent } from "../agent.js";
import type { ConversationState } from "../context/types.js";
import { handleInteractiveSubmission } from "../index.js";
import { PASTE_THRESHOLD } from "../ui/input/constants.js";
import { expandPastedRefs } from "../ui/input/expandSubmit.js";
import type { PastedContent } from "../ui/input/pastedContent.js";
import {
  isImageOnlySubmission,
  isSubmissionEmpty,
  type PromptSubmission,
} from "../ui/input/promptSubmission.js";
import type { PromptComposer } from "../ui/promptComposer.js";
import { TerminalUi } from "../ui/terminal.js";
import { createAbortStateController } from "../ui/abortState.js";
import {
  createTtyInputStream,
  withKeypressEvents,
} from "../ui/__tests__/ttyTestStream.js";
import { createMockWriteStream } from "./testHelpers.js";

function emptyConversationState(): ConversationState {
  return {
    preamble: [],
    turns: [],
    artifacts: [],
    pinnedMemory: [],
    invokedSkills: [],
    rollingSummary: null,
  };
}

function createCapturingAgent(): {
  agent: Agent;
  getSubmission: () => PromptSubmission | undefined;
} {
  let agentSubmission: PromptSubmission | undefined;
  const agent = {
    async streamChat(
      nextSubmission: PromptSubmission,
      _onToken: (token: string) => void,
    ): Promise<string> {
      agentSubmission = nextSubmission;
      return "ok";
    },
    getLastTurnReasoningSummary: () => null,
    getConversationState: emptyConversationState,
  } as unknown as Agent;

  return { agent, getSubmission: () => agentSubmission };
}

function createInteractiveUi(): TerminalUi {
  return new TerminalUi({
    interactive: true,
    plain: true,
    json: false,
    stdout: createMockWriteStream(),
    stderr: createMockWriteStream(),
  });
}

async function runInteractiveSubmission(
  submission: PromptSubmission,
  agent: Agent,
  ui: TerminalUi,
): Promise<number | null> {
  const abortState = createAbortStateController(ui);
  return handleInteractiveSubmission(submission, {
    agent,
    ui,
    composer: {} as PromptComposer,
    configPath: "/tmp/providers.json",
    inputStream: withKeypressEvents(createTtyInputStream()),
    interactiveInput: true,
    setCurrentAbortController: abortState.setCurrentAbortController,
    cancelActiveTurn: abortState.cancelActiveTurn,
    shouldExit: abortState.shouldExit,
    getVisibility: () => ({
      showToolCalls: false,
      showThinking: false,
      showStatus: false,
      showReasoningSummary: false,
      showContextStats: false,
      showPromptPlan: false,
    }),
  });
}

describe("handleInteractiveSubmission chat path", () => {
  it("persists displayText to the transcript and passes expanded text to the agent", async () => {
    const largeBody = "z".repeat(PASTE_THRESHOLD + 1);
    const registry = new Map<number, PastedContent>([
      [1, { id: 1, type: "text", content: largeBody }],
    ]);
    const submission = expandPastedRefs("[Pasted text #1]", registry, "prompt");

    const { agent, getSubmission } = createCapturingAgent();

    const ui = createInteractiveUi();
    const persistSubmittedInput = jest.spyOn(ui, "persistSubmittedInput");
    const exitCode = await runInteractiveSubmission(submission, agent, ui);

    expect(exitCode).toBeNull();
    expect(persistSubmittedInput).toHaveBeenCalledWith("[Pasted text #1]");
    expect(getSubmission()).toEqual(
      expect.objectContaining({
        text: largeBody,
        displayText: "[Pasted text #1]",
      }),
    );
    expect(getSubmission()?.text).not.toContain("[Pasted text #1]");
  });

  it("rejects slash commands when images are attached", async () => {
    const submission: PromptSubmission = {
      text: "/help",
      displayText: "[Image #1]",
      inputMode: "prompt",
      images: ["data:image/png;base64,abc"],
    };

    const agent = {
      async streamChat(): Promise<string> {
        throw new Error("streamChat should not run");
      },
      getLastTurnReasoningSummary: () => null,
      getConversationState: emptyConversationState,
    } as unknown as Agent;

    const ui = createInteractiveUi();
    const error = jest.spyOn(ui, "error");

    const exitCode = await runInteractiveSubmission(submission, agent, ui);

    expect(exitCode).toBeNull();
    expect(error).toHaveBeenCalledWith(
      "Images cannot be sent with slash commands.",
    );
  });

  it("allows image-only submissions to reach the agent", async () => {
    const dataUrl = "data:image/png;base64,abc";
    const registry = new Map<number, PastedContent>([
      [
        1,
        {
          id: 1,
          type: "image",
          data: dataUrl,
          mediaType: "image/png",
          filename: "photo.png",
        },
      ],
    ]);
    const submission = expandPastedRefs("[Image #1]", registry, "prompt");

    expect(isSubmissionEmpty(submission)).toBe(false);
    expect(isImageOnlySubmission(submission)).toBe(true);

    const { agent, getSubmission } = createCapturingAgent();
    await runInteractiveSubmission(submission, agent, createInteractiveUi());

    expect(getSubmission()).toEqual(
      expect.objectContaining({
        text: "[Attached image: photo.png]",
        images: [dataUrl],
      }),
    );
  });
});
