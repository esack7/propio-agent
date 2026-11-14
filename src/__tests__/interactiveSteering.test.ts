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
import type { ChatChunk, ChatRequest, LLMProvider } from "@propio-ai/providers";
import type { Agent } from "../agent.js";
import { formatOperatorGuidance } from "../agent-core/runtime.js";
import {
  answerApprovalsThrough,
  borrowingKeyboard,
  createCliTurnSession,
} from "../cli/turnSession.js";
import { runInteractiveTurn } from "../index.js";
import { createAbortStateController } from "../ui/abortState.js";
import { createApprovalPromptChannel } from "../ui/approvalPrompt.js";
import { createPlainSubmission } from "../ui/input/promptSubmission.js";
import type { PromptComposer } from "../ui/promptComposer.js";
import { TerminalUi } from "../ui/terminal.js";
import type { TurnInput } from "../ui/turnInput.js";
import {
  createTtyInputStream,
  createTtyTestStream,
  withKeypressEvents,
} from "../ui/__tests__/ttyTestStream.js";
import { createMockTool, createTestAgent } from "./testHelpers.js";

type Step = {
  say?: string;
  call?: [name: string, args: Record<string, unknown>];
};

/** A provider that follows a script, one step per request. */
function scripted(steps: Step[]): LLMProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: "scripted",
    requests,
    getCapabilities: () => ({ contextWindowTokens: 128000 }),
    async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
      const step = steps[requests.length] ?? { say: "Nothing more." };
      requests.push(request);
      yield {
        delta: step.say ?? "",
        ...(step.call
          ? {
              toolCalls: [
                {
                  id: `call-${requests.length}`,
                  function: { name: step.call[0], arguments: step.call[1] },
                },
              ],
            }
          : {}),
      };
    },
  };
}

const userTexts = (request: ChatRequest) =>
  request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 500; tries++) {
    if (condition()) return;
    await tick();
  }
  throw new Error("condition not met in time");
}

/** The terminal as the CLI builds it for a TTY: the retained view on stderr. */
function createTerminal(agent: Agent) {
  const stderr = createTtyTestStream(true, 80);
  const ui = new TerminalUi({
    interactive: true,
    plain: false,
    json: false,
    stdout: createTtyTestStream(),
    stderr,
  });
  const input = withKeypressEvents(createTtyInputStream());
  const abortState = createAbortStateController(ui);
  const turnSession = createCliTurnSession(agent, ui, () => ({
    showToolCalls: true,
    showThinking: false,
    showStatus: false,
    showReasoningSummary: false,
    showContextStats: false,
    showPromptPlan: false,
  }));
  const restored: string[] = [];
  let activeTurnInput: TurnInput | null = null;
  const context = {
    agent,
    ui,
    composer: {} as PromptComposer,
    configPath: "/tmp/providers.json",
    inputStream: input as unknown as NodeJS.ReadStream,
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
    turnSession,
    setActiveTurnInput: (turnInput: TurnInput | null) => {
      activeTurnInput = turnInput;
    },
    restoreInput: (text: string) => {
      restored.push(text);
    },
  };
  const type = (text: string) => {
    for (const character of text)
      input.emit("keypress", character, {
        name: character,
        ctrl: false,
        meta: false,
      });
  };
  const press = (name: string) =>
    input.emit("keypress", undefined, { name, ctrl: false, meta: false });
  return {
    ui,
    context,
    turnSession,
    abortState,
    restored,
    input,
    type,
    press,
    activeTurnInput: () => activeTurnInput,
    screen: () => stderr.chunks.join(""),
    run: (text: string) =>
      runInteractiveTurn(createPlainSubmission(text, "prompt"), context, {
        errorPrefix: "Error: ",
      }),
  };
}

describe("steering a turn from the terminal", () => {
  it("sends what is typed mid-turn to the model before its next request (a1, a5)", async () => {
    const provider = scripted([
      { call: ["lookup", {}] },
      { say: "Here are the 2024 records." },
    ]);
    let started = false;
    let finishLookup!: () => void;
    const agent = createTestAgent(provider);
    agent.addTool(
      createMockTool({
        name: "lookup",
        execute: () => {
          started = true;
          return new Promise<string>((resolve) => {
            finishLookup = () => resolve("found 40 records");
          });
        },
      }),
    );
    const terminal = createTerminal(agent);

    const turn = terminal.run("Find the records");
    await until(() => started);

    // Typing shows a line under the output; the turn keeps running.
    terminal.type("only 2024");
    expect(terminal.screen()).toContain("only 2024");
    expect(terminal.screen()).not.toContain("queued");
    expect(terminal.turnSession.session.running).toBe(true);

    terminal.press("return");
    // Sent, and shown as waiting: the tool is still running.
    const queuedAt = terminal.screen().indexOf("queued");
    expect(queuedAt).toBeGreaterThan(0);
    expect(terminal.screen().slice(queuedAt)).toContain("only 2024");
    expect(provider.requests).toHaveLength(1);

    finishLookup();
    await expect(turn).resolves.toBeNull();

    // The model received it before its second request, after the result.
    expect(userTexts(provider.requests[1]!)).toEqual([
      "Find the records",
      formatOperatorGuidance("only 2024"),
    ]);
    expect(provider.requests[1]!.messages.at(-1)).toMatchObject({
      role: "user",
      content: formatOperatorGuidance("only 2024"),
    });
    // The transcript shows it again where the model received it: after the
    // queued line and before the answer that took it into account.
    const screen = terminal.screen();
    const deliveredAt = screen.indexOf("only 2024", queuedAt + 20);
    expect(deliveredAt).toBeGreaterThan(queuedAt);
    expect(screen.indexOf("Here are the 2024 records.")).toBeGreaterThan(
      deliveredAt,
    );
    // Nothing was left over to put back in the prompt.
    expect(terminal.restored).toEqual([]);
    expect(terminal.abortState.shouldExit()).toBe(false);
  });

  it("holds the turn's output while a line is being typed, then lets it catch up", async () => {
    const provider = scripted([
      { call: ["lookup", {}] },
      { say: "Progress note.", call: ["lookup", {}] },
      { say: "Done." },
    ]);
    const finish: Array<() => void> = [];
    const agent = createTestAgent(provider);
    agent.addTool(
      createMockTool({
        name: "lookup",
        execute: () =>
          new Promise<string>((resolve) => {
            finish.push(() => resolve("found"));
          }),
      }),
    );
    const terminal = createTerminal(agent);
    const turn = terminal.run("Find the records");
    await until(() => finish.length === 1);

    terminal.type("wait");
    finish[0]!();
    // The turn moves on to its second step and second tool call...
    await until(() => finish.length === 2);
    expect(provider.requests).toHaveLength(2);
    // ...but what it printed meanwhile is not drawn under the typed line.
    expect(terminal.screen()).not.toContain("Progress note.");

    // Erasing the line releases what was held.
    for (let i = 0; i < 4; i++) terminal.press("backspace");
    expect(terminal.screen()).toContain("Progress note.");

    finish[1]!();
    await expect(turn).resolves.toBeNull();
    expect(terminal.screen()).toContain("Done.");
    expect(terminal.restored).toEqual([]);
  });

  it("returns to the prompt on Escape with unsent input, and the session goes on (a6)", async () => {
    const provider = scripted([
      { call: ["lookup", {}] },
      { say: "Carrying on." },
    ]);
    let started = false;
    const agent = createTestAgent(provider);
    agent.addTool(
      createMockTool({
        name: "lookup",
        execute: () => {
          started = true;
          return new Promise<string>(() => {});
        },
      }),
    );
    const terminal = createTerminal(agent);
    const turn = terminal.run("Find the records");
    await until(() => started);

    // One line sent but never delivered, and one still being typed.
    terminal.type("only 2024");
    terminal.press("return");
    terminal.type("and sort by");
    terminal.press("escape");

    // Back at the prompt, not exiting.
    await expect(turn).resolves.toBeNull();
    expect(terminal.abortState.shouldExit()).toBe(false);
    expect(terminal.turnSession.session.running).toBe(false);
    // Both go back to the prompt to edit, in the order they were typed.
    expect(terminal.restored).toEqual(["only 2024\nand sort by"]);
    // The model never saw either.
    expect(JSON.stringify(agent.getConversationState())).not.toContain(
      "only 2024",
    );
    // The keyboard is released for the prompt.
    expect(terminal.input.setRawMode).toHaveBeenLastCalledWith(false);

    // The next message continues from the interrupted turn's work.
    await expect(terminal.run("Go on")).resolves.toBeNull();
    const next = provider.requests[1]!;
    expect(userTexts(next)).toEqual(["Find the records", "Go on"]);
    const results = next.messages.flatMap(
      (message) => message.toolResults ?? [],
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toMatch(
      /^\[Interrupted before this call finished/,
    );
  });

  it("puts unsent input back when the turn ends before it could be delivered", async () => {
    // The answer is the last step the iteration limit allows.
    const provider = scripted([{ say: "Done." }]);
    const agent = createTestAgent(provider);
    const terminal = createTerminal(agent);
    const turn = terminal.run("Hello");
    terminal.type("half typed");
    await expect(turn).resolves.toBeNull();
    expect(terminal.restored).toEqual(["half typed"]);
  });
});

describe("an approval question while a line is being typed", () => {
  let workspace: string;
  let cwdSpy: jest.SpiedFunction<typeof process.cwd>;

  beforeEach(() => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "propio-steering-")),
    );
    fs.writeFileSync(path.join(workspace, "notes.txt"), "original");
    cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(workspace);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("takes the keyboard, keeps the draft, and gives both back", async () => {
    const provider = scripted([
      {
        say: "Writing.",
        call: ["write", { path: "notes.txt", content: "changed" }],
      },
      { say: "Written, briefly." },
    ]);
    const agent = createTestAgent(provider, { permissions: undefined });
    const terminal = createTerminal(agent);
    agent.setApprovalChannel(
      terminal.turnSession.session.approvalChannel,
      "application",
    );
    const duringQuestion: Array<{ lineShowing: boolean }> = [];
    answerApprovalsThrough(
      terminal.turnSession.session,
      borrowingKeyboard(
        createApprovalPromptChannel({
          show: () => {},
          readLine: async () => {
            // The typed line is off the screen and output flows again.
            const before = terminal.screen();
            terminal.ui.info("visible during the question");
            duringQuestion.push({
              lineShowing: terminal.screen() === before,
            });
            // Keys now belong to the question, not the draft.
            terminal.type("zzz");
            return "y";
          },
        }),
        terminal.activeTurnInput,
      ),
    );
    terminal.turnSession.session.subscribe((event) => {
      // The question is answered: the draft is back and can be finished.
      if (event.type === "approval_resolved") {
        terminal.type("ef");
        terminal.press("return");
      }
    });

    const turn = terminal.run("Change the notes");
    terminal.type("be bri");
    expect(terminal.screen()).toContain("be bri");

    await expect(turn).resolves.toBeNull();

    expect(duringQuestion).toEqual([{ lineShowing: false }]);
    expect(fs.readFileSync(path.join(workspace, "notes.txt"), "utf8")).toBe(
      "changed",
    );
    // The draft survived the question, without the question's keys in it.
    expect(userTexts(provider.requests[1]!)).toEqual([
      "Change the notes",
      formatOperatorGuidance("be brief"),
    ]);
    expect(terminal.restored).toEqual([]);
  });
});
