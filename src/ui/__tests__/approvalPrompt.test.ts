import { getEventListeners } from "events";
import { PassThrough } from "stream";
import type { ApprovalRequest } from "../../policy/index.js";
import {
  createConfirmApprovalChannel,
  formatApprovalPrompt,
  visibleText,
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

describe("visibleText", () => {
  it.each([
    ["\x1b[2K\rls", "\\x1b[2K\\rls"],
    ["a\nb\tc", "a\\nb\\tc"],
    ["back\bspace\x7f", "back\\x08space\\x7f"],
    ["c1 \u009b31m", "c1 \\x9b31m"],
    ["rm -rf \u202eexe.txt", "rm -rf \\u202eexe.txt"],
    ["zero\u200bwidth\ufeff", "zero\\u200bwidth\\ufeff"],
    ["already \\x1b text", "already \\\\x1b text"],
    ["plain ünïcode → ok", "plain ünïcode → ok"],
  ])("renders %j as %j", (input, expected) => {
    expect(visibleText(input)).toBe(expected);
  });
});

describe("untrusted fields in the prompt", () => {
  // Erase the line, return to its start, and write an innocent command over
  // the real one.
  const disguise = "rm -rf ~\x1b[2K\rnpm test";

  function printable(text: string): boolean {
    return !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e]/u.test(
      text,
    );
  }

  it.each([
    [
      "command",
      {
        args: { command: disguise },
        target: { kind: "command", command: disguise },
      },
    ],
    [
      "directory and environment",
      {
        args: { command: "ls", cwd: "/tmp\x1b[8m", env: { A: "\u202e" } },
        target: { kind: "command", command: "ls" },
      },
    ],
    [
      "path",
      {
        toolName: "write",
        args: { path: "x" },
        target: { kind: "path", path: "/work/\x1b]8;;evil\x07a.txt" },
      },
    ],
    [
      "other arguments",
      {
        toolName: "mcp__x__y",
        args: { title: "\x1b[2Jcleared" },
        target: { kind: "mcp", serverPrefix: "mcp__x" },
      },
    ],
    ["tool name", { toolName: "mcp__x__\x1b[31mred" }],
    ["reason", { reason: "Matched user ask rule bash(\x1b[8mhidden)" }],
  ] as const)("shows the %s with no control characters", (_label, change) => {
    const text = formatApprovalPrompt({
      ...base,
      ...(change as Partial<ApprovalRequest>),
    });

    expect(printable(text)).toBe(true);
  });

  it("shows the whole disguised command", () => {
    expect(
      formatApprovalPrompt({
        ...base,
        args: { command: disguise },
        target: { kind: "command", command: disguise },
      }),
    ).toContain("Command: rm -rf ~\\x1b[2K\\rnpm test");
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

  it("leaves no listener on the turn's signal after each prompt ends", async () => {
    const { input, composer: prompts } = composer();
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, "abort").length;

    for (let index = 0; index < 12; index++) {
      const answered = prompts.confirm({
        promptText: "Allow? ",
        defaultValue: false,
        signal: controller.signal,
      });
      await tick();
      input.write(index % 2 === 0 ? "y\n" : "\n");
      await answered;
    }
    const closing = prompts.confirm({
      promptText: "Allow? ",
      defaultValue: false,
      signal: controller.signal,
    });
    await tick();
    prompts.close();
    await expect(closing).resolves.toBe(false);

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(before);
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
