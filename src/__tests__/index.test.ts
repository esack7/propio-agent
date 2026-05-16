import type { Agent } from "../agent.js";
import type { ConversationState } from "../context/types.js";
import { runNonInteractiveSession } from "../index.js";
import { TerminalUi } from "../ui/terminal.js";

function createMockStream(): NodeJS.WriteStream & { chunks: string[] } {
  const chunks: string[] = [];

  return {
    chunks,
    columns: 80,
    isTTY: false,
    write: (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    },
  } as unknown as NodeJS.WriteStream & { chunks: string[] };
}

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

describe("index non-interactive session", () => {
  it("returns exit code 1 when an incomplete turn rejects", async () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const ui = new TerminalUi({
      interactive: false,
      plain: true,
      json: false,
      stdout,
      stderr,
    });
    const incompleteMessage =
      "Stopped after reaching max iterations before a final assistant response. The last output may be incomplete.";
    const agent = {
      async streamChat(): Promise<string> {
        throw new Error(incompleteMessage);
      },
      getLastTurnReasoningSummary: () => null,
      getConversationState: emptyConversationState,
    } as unknown as Agent;
    let currentAbortController: AbortController | null = null;

    const exitCode = await runNonInteractiveSession(
      agent,
      ui,
      (controller) => {
        currentAbortController = controller;
      },
      {
        showActivity: false,
        showStatus: false,
        showReasoningSummary: false,
        showContextStats: false,
        showPromptPlan: false,
      },
      {
        stdinIsTTY: false,
        readInput: async () => "hello\n",
      },
    );

    expect(exitCode).toBe(1);
    expect(currentAbortController).toBeNull();
    expect(stderr.chunks.join("")).toContain(`Error: ${incompleteMessage}`);
    expect(stdout.chunks.join("")).toBe("");
  });
});
