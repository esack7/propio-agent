import { getEventListeners } from "events";
import { PassThrough } from "stream";
import type {
  ApprovalAnswer,
  ApprovalRequest,
  GrantSuggestion,
} from "../../policy/index.js";
import {
  askOperator,
  createApprovalPromptChannel,
  formatApprovalRequest,
  type ApprovalPromptIo,
} from "../approvalPrompt.js";
import { visibleText } from "../visibleText.js";
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

const formatApprovalPrompt = (request: ApprovalRequest): string =>
  formatApprovalRequest(request).join("\n");

describe("formatApprovalRequest", () => {
  it("shows the command and why it asks", () => {
    expect(formatApprovalRequest(base)).toEqual([
      "bash needs approval.",
      "Command: npm test",
      "Reason: Calls with the process capability need approval in ask mode",
    ]);
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

const SUGGESTIONS: GrantSuggestion[] = [
  { rule: "bash(npm test)", scope: "exact", description: "this exact command" },
  { rule: "bash", scope: "tool", description: "every call to bash" },
  {
    rule: "capability:process",
    scope: "capability",
    description: "every call with the process capability",
  },
];
const withGrants: ApprovalRequest = { ...base, suggestions: SUGGESTIONS };

/** An operator who types the given lines; null withdraws the question. */
function scriptedIo(lines: Array<string | null>): ApprovalPromptIo & {
  shown: string[];
  asked: string[];
} {
  const shown: string[] = [];
  const asked: string[] = [];
  return {
    shown,
    asked,
    show: (text) => shown.push(...text),
    readLine: async (promptText) => {
      asked.push(promptText);
      if (lines.length === 0) throw new Error("asked more than scripted");
      return lines.shift() as string | null;
    },
  };
}

async function answerTo(
  lines: Array<string | null>,
  request: ApprovalRequest = withGrants,
): Promise<{ answer: ApprovalAnswer; io: ReturnType<typeof scriptedIo> }> {
  const io = scriptedIo(lines);
  return { answer: await askOperator(request, io), io };
}

describe("askOperator", () => {
  it("shows the request and the choices before asking", async () => {
    const { io } = await answerTo(["y"]);

    expect(io.shown).toEqual([
      "bash needs approval.",
      "Command: npm test",
      "Reason: Calls with the process capability need approval in ask mode",
      "",
      "  y  allow once",
      "  s  allow for this session",
      "  a  always allow (saved to your settings)",
      '  n  deny; a reason for the model may follow, as in "n use staging"',
    ]);
    expect(io.asked).toEqual(["Allow? [y/s/a/N] "]);
  });

  it.each(["y", "Y", "yes", "  yes  "])("allows once for %j", async (line) => {
    expect((await answerTo([line])).answer).toEqual({
      requestId: "approval-1",
      decision: "allow_once",
    });
  });

  it.each(["", "n", "N", "no", "deny", "  "])("denies for %j", async (line) => {
    expect((await answerTo([line])).answer).toEqual({
      requestId: "approval-1",
      decision: "deny",
    });
  });

  it("denies when the question is withdrawn, at either step", async () => {
    expect((await answerTo([null])).answer.decision).toBe("deny");
    expect((await answerTo(["s", null])).answer.decision).toBe("deny");
  });

  it("passes on a reason for the model", async () => {
    expect((await answerTo(["n use the  staging database"])).answer).toEqual({
      requestId: "approval-1",
      decision: "deny",
      reason: "use the staging database",
    });
  });

  it.each([
    ["s", "allow_session", "for this session"],
    ["session", "allow_session", "for this session"],
    ["a", "allow_always", "always"],
    ["always", "allow_always", "always"],
  ] as const)(
    "for %j lists the grants and answers %s with the one chosen",
    async (line, decision, scope) => {
      const { answer, io } = await answerTo([line, "2"]);

      expect(answer).toEqual({
        requestId: "approval-1",
        decision,
        rule: "bash",
      });
      expect(io.shown.slice(-4)).toEqual([
        `Allow ${scope}:`,
        "  1. this exact command  [bash(npm test)]",
        "  2. every call to bash  [bash]",
        "  3. every call with the process capability  [capability:process]",
      ]);
      expect(io.asked.at(-1)).toBe("Which? [1-3, Enter to go back] ");
    },
  );

  it("asks again for a grant number that is not offered", async () => {
    const { answer, io } = await answerTo(["s", "0", "4", "two", "1"]);

    expect(answer).toMatchObject({ rule: "bash(npm test)" });
    expect(
      io.shown.filter((line) => line === "Enter a number from 1 to 3."),
    ).toHaveLength(3);
  });

  it("goes back to the choices on an empty grant, granting nothing", async () => {
    const { answer, io } = await answerTo(["a", "", "n"]);

    expect(answer).toEqual({ requestId: "approval-1", decision: "deny" });
    expect(io.asked).toEqual([
      "Allow? [y/s/a/N] ",
      "Which? [1-3, Enter to go back] ",
      "Allow? [y/s/a/N] ",
    ]);
  });

  it("asks again for anything it does not understand, never allowing by default", async () => {
    const { answer, io } = await answerTo(["maybe", "ok", "sure", "y"]);

    expect(answer.decision).toBe("allow_once");
    expect(
      io.shown.filter((line) => line === "Enter y, s, a, or n."),
    ).toHaveLength(3);
  });

  it("offers no grants when none covers the call", async () => {
    const { answer, io } = await answerTo(["s", "y"], base);

    expect(io.shown).not.toContain("  s  allow for this session");
    expect(io.shown).toContain(
      "No grant covers this call; allow it once or deny it.",
    );
    expect(answer.decision).toBe("allow_once");
  });

  it("shows a grant made from the command with its control characters escaped, and answers with the real rule", async () => {
    const rule = "bash(echo \x1b[2Khidden)";
    const { answer, io } = await answerTo(["s", "1"], {
      ...base,
      suggestions: [
        { rule, scope: "exact", description: "this exact command" },
      ],
    });

    expect(io.shown).toContain(
      "  1. this exact command  [bash(echo \\x1b[2Khidden)]",
    );
    expect(answer).toMatchObject({ rule });
  });

  describe("where rules cannot be saved", () => {
    const options = {
      savingUnavailableReason: async () =>
        "sandbox mode reads your settings from a read-only copy",
    };
    const ask = async (lines: Array<string | null>) => {
      const io = scriptedIo(lines);
      return {
        answer: await askOperator(withGrants, io, undefined, options),
        io,
      };
    };

    it("does not offer always allow, and says why", async () => {
      const { io } = await ask(["y"]);

      expect(io.shown).toContain("  s  allow for this session");
      expect(io.shown).not.toContain(
        "  a  always allow (saved to your settings)",
      );
      expect(io.shown).toContain(
        "     (always allow is unavailable: sandbox mode reads your settings from a read-only copy)",
      );
      expect(io.asked).toEqual(["Allow? [y/s/N] "]);
    });

    it("explains instead of saving when a is typed anyway, and never answers always", async () => {
      const { answer, io } = await ask(["a", "always", "s", "1"]);

      expect(
        io.shown.filter(
          (line) =>
            line ===
            "Always allow is unavailable: sandbox mode reads your settings from a read-only copy.",
        ),
      ).toHaveLength(2);
      expect(answer).toEqual({
        requestId: "approval-1",
        decision: "allow_session",
        rule: "bash(npm test)",
      });
    });

    it("names only the choices it offers when the answer is not understood", async () => {
      const { io } = await ask(["maybe", "n"]);

      expect(io.shown).toContain("Enter y, s, or n.");
    });
  });

  it("offers always allow where no reason against it is given", async () => {
    const io = scriptedIo(["a", "1"]);

    const answer = await askOperator(withGrants, io, undefined, {
      savingUnavailableReason: async () => undefined,
    });

    expect(answer).toMatchObject({ decision: "allow_always" });
  });

  it("hands the turn's signal to every question", async () => {
    const signal = new AbortController().signal;
    const signals: Array<AbortSignal | undefined> = [];
    const io: ApprovalPromptIo = {
      show: () => {},
      readLine: async (_text, received) => {
        signals.push(received);
        return signals.length === 1 ? "s" : "1";
      },
    };

    await createApprovalPromptChannel(io).request(withGrants, signal);

    expect(signals).toEqual([signal, signal]);
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
