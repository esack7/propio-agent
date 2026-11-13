import { PassThrough } from "stream";
import type { ApprovalRequest } from "../../policy/index.js";
import {
  createConfirmApprovalChannel,
  formatApprovalPrompt,
} from "../approvalPrompt.js";
import { createPromptComposer } from "../promptComposer.js";

const base: ApprovalRequest = {
  id: "approval-1",
  toolName: "bash",
  args: { command: "npm test" },
  capabilities: ["process"],
  target: { kind: "command", command: "npm test" },
  reason: "Calls with the process capability need approval in ask mode",
  rule: "mode:ask",
  suggestions: [],
};

describe("formatApprovalPrompt", () => {
  it("shows the command and why it asks", () => {
    expect(formatApprovalPrompt(base)).toBe(
      [
        "bash needs approval.",
        "Command: npm test",
        "Reason: Calls with the process capability need approval in ask mode",
        "",
        "Allow this call? (y/N) ",
      ].join("\n"),
    );
  });

  it("shows where a command runs and what environment it sets", () => {
    const text = formatApprovalPrompt({
      ...base,
      args: { command: "npm test", cwd: "/tmp/x", env: { CI: "1" } },
    });

    expect(text).toContain("Directory: /tmp/x");
    expect(text).toContain('Environment: {"CI":"1"}');
  });

  it("shows the resolved path of a file call", () => {
    expect(
      formatApprovalPrompt({
        ...base,
        toolName: "write",
        args: { path: "link/a.txt", content: "x" },
        target: { kind: "path", path: "/real/place/a.txt" },
      }),
    ).toContain("Path: /real/place/a.txt");
  });

  it("shows bounded arguments for any other tool", () => {
    const text = formatApprovalPrompt({
      ...base,
      toolName: "mcp__github__create_issue",
      args: { title: "x".repeat(1000) },
      target: { kind: "mcp", serverPrefix: "mcp__github" },
    });

    expect(text).toContain('Arguments: {"title":"xxx');
    expect(text.length).toBeLessThan(700);
  });
});

describe("createConfirmApprovalChannel", () => {
  it("answers allow once for yes and deny for anything else", async () => {
    const yes = createConfirmApprovalChannel(async () => true);
    const no = createConfirmApprovalChannel(async () => false);

    expect(await yes.request(base)).toEqual({
      requestId: "approval-1",
      decision: "allow_once",
    });
    expect(await no.request(base)).toEqual({
      requestId: "approval-1",
      decision: "deny",
    });
  });

  it("puts the formatted request and the turn's signal to the prompt", async () => {
    const confirm = jest.fn(async () => false);
    const signal = new AbortController().signal;

    await createConfirmApprovalChannel(confirm).request(base, signal);

    expect(confirm).toHaveBeenCalledWith(formatApprovalPrompt(base), signal);
  });
});

describe("a confirm prompt closed by its signal", () => {
  function composer() {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    return {
      input,
      composer: createPromptComposer({
        input: input as unknown as NodeJS.ReadStream,
        output: output as unknown as NodeJS.WriteStream,
      }),
    };
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("resolves to the default and leaves the next prompt usable", async () => {
    const { input, composer: prompts } = composer();
    const controller = new AbortController();

    const cancelled = prompts.confirm({
      promptText: "Allow? ",
      defaultValue: false,
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    await expect(cancelled).resolves.toBe(false);

    // The next prompt still receives its own answer.
    const next = prompts.confirm({
      promptText: "Allow? ",
      defaultValue: false,
    });
    await tick();
    input.write("y\n");
    await expect(next).resolves.toBe(true);
    prompts.close();
  });

  it("does not open a prompt for a signal that is already aborted", async () => {
    const { composer: prompts } = composer();

    await expect(
      prompts.confirm({
        promptText: "Allow? ",
        defaultValue: false,
        signal: AbortSignal.abort(),
      }),
    ).resolves.toBe(false);
    prompts.close();
  });
});
