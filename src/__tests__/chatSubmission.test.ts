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

describe("handleInteractiveSubmission chat path", () => {
  it("persists displayText to the transcript and passes expanded text to the agent", async () => {
    const largeBody = "z".repeat(PASTE_THRESHOLD + 1);
    const registry = new Map<number, PastedContent>([
      [1, { id: 1, type: "text", content: largeBody }],
    ]);
    const submission = expandPastedRefs("[Pasted text #1]", registry, "prompt");

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

    const stdout = createMockWriteStream();
    const stderr = createMockWriteStream();
    const ui = new TerminalUi({
      interactive: true,
      plain: true,
      json: false,
      stdout,
      stderr,
    });
    const persistSubmittedInput = jest.spyOn(ui, "persistSubmittedInput");
    const abortState = createAbortStateController(ui);
    const inputStream = withKeypressEvents(createTtyInputStream());

    const exitCode = await handleInteractiveSubmission(submission, {
      agent,
      ui,
      composer: {} as PromptComposer,
      configPath: "/tmp/providers.json",
      inputStream,
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

    expect(exitCode).toBeNull();
    expect(persistSubmittedInput).toHaveBeenCalledWith("[Pasted text #1]");
    expect(agentSubmission).toEqual(
      expect.objectContaining({
        text: largeBody,
        displayText: "[Pasted text #1]",
      }),
    );
    expect(agentSubmission?.text).not.toContain("[Pasted text #1]");
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

    const ui = new TerminalUi({
      interactive: true,
      plain: true,
      json: false,
      stdout: createMockWriteStream(),
      stderr: createMockWriteStream(),
    });
    const error = jest.spyOn(ui, "error");
    const abortState = createAbortStateController(ui);

    const exitCode = await handleInteractiveSubmission(submission, {
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

    const ui = new TerminalUi({
      interactive: true,
      plain: true,
      json: false,
      stdout: createMockWriteStream(),
      stderr: createMockWriteStream(),
    });
    const abortState = createAbortStateController(ui);

    await handleInteractiveSubmission(submission, {
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

    expect(agentSubmission).toEqual(
      expect.objectContaining({
        text: "[Attached image: photo.png]",
        images: [dataUrl],
      }),
    );
  });
});
