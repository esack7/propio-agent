import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamAssistantTurn } from "../ui/assistantTurnRenderer.js";
import { createConfirmApprovalChannel } from "../ui/approvalPrompt.js";
import { createPlainSubmission } from "../ui/input/promptSubmission.js";
import { TerminalUi } from "../ui/terminal.js";
import { createTtyTestStream } from "../ui/__tests__/ttyTestStream.js";
import { createTestAgent, ToolCallMockProvider } from "./testHelpers.js";

/**
 * A command that, printed raw, erases its own line and writes an innocent
 * one over it: the operator would see only "npm test".
 */
const INJECTED = "\x1b[2K\r";
const DISGUISED = `rm -rf ~/work${INJECTED}npm test`;
const SHOWN = "rm -rf ~/work\\x1b[2K\\rnpm test";

describe("a turn that asks about a disguised command", () => {
  let workspace: string;
  let cwdSpy: jest.SpiedFunction<typeof process.cwd>;

  beforeEach(() => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "propio-render-")),
    );
    cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(workspace);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it.each([
    ["the retained interactive view", { interactive: true, plain: false }],
    ["plain output", { interactive: false, plain: true }],
  ])(
    "shows it escaped from the tool event through the question, in %s",
    async (_label, mode) => {
      const stdout = createTtyTestStream();
      const stderr = createTtyTestStream();
      const ui = new TerminalUi({ ...mode, json: false, stdout, stderr });
      const questions: string[] = [];
      const agent = createTestAgent(
        new ToolCallMockProvider("bash", { command: DISGUISED }),
        {
          permissions: {
            approvalChannel: createConfirmApprovalChannel(async (text) => {
              // As the CLI does: the question is written to the terminal.
              questions.push(text);
              ui.getPromptOutputStream().write(ui.prompt(text));
              return false;
            }),
          },
        },
      );

      await streamAssistantTurn(
        agent,
        createPlainSubmission("Clean up", "prompt"),
        ui,
        new AbortController().signal,
        () => ({
          showToolCalls: true,
          showThinking: true,
          showStatus: false,
          showReasoningSummary: false,
          showContextStats: false,
          showPromptPlan: false,
        }),
      );
      ui.cleanup();
      const terminal = [...stdout.chunks, ...stderr.chunks].join("");

      expect(questions).toHaveLength(1);
      // Nothing the model wrote reached the terminal as a control sequence.
      expect(terminal).not.toContain(INJECTED);
      expect(terminal).not.toContain(`work${INJECTED}`);
      // The tool line came first, and both it and the question show the
      // whole command.
      const toolLine = terminal.indexOf(`Bash ${SHOWN}`);
      const question = terminal.indexOf(`Command: ${SHOWN}`);
      expect(toolLine).toBeGreaterThanOrEqual(0);
      expect(question).toBeGreaterThan(toolLine);
    },
  );
});
