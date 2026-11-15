import { describe, expect, it } from "@jest/globals";
import type { ToolDisplay } from "../../../tools/display.js";
import { getDisplayWidth } from "../../displayWidth.js";
import { renderToolDisplay } from "../render.js";

const displays: ToolDisplay[] = [
  {
    title: "Editing 界.ts",
    body: {
      kind: "diff",
      path: "界.ts",
      operation: "replace",
      added: 1,
      removed: 1,
      truncated: false,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            { op: "-", text: "old" },
            { op: "+", text: "new", noNewline: true },
          ],
        },
      ],
    },
  },
  {
    title: "Running command",
    body: {
      kind: "command",
      command: "npm test",
      stdoutTail: "passed\nfinished",
      stderrTail: "warning",
      exitCode: 0,
      truncated: false,
    },
  },
  {
    title: "Reading file",
    body: {
      kind: "file_read",
      path: "界.ts",
      lines: 214,
      range: { start: 10, count: 20 },
    },
  },
  {
    title: "Searching",
    body: {
      kind: "search",
      mode: "content",
      pattern: "foo",
      scope: "src",
      matches: 12,
      files: 4,
      sample: ["src/a.ts: foo"],
    },
  },
  {
    title: "MCP call",
    body: {
      kind: "generic",
      fields: [{ key: "query", value: "hello" }],
      resultPreview: "one\ntwo",
      truncated: false,
    },
  },
];

describe("tool display rendering", () => {
  for (const display of displays)
    for (const status of ["running", "success", "error"] as const)
      for (const width of [40, 120])
        for (const mode of ["collapsed", "expanded"] as const) {
          it(`${display.body.kind} ${status} ${width} ${mode}`, () => {
            const lines = renderToolDisplay(
              {
                ...display,
                ...(status === "error" ? { error: "Permission denied" } : {}),
              },
              { status, durationMs: 12400 },
              width,
              mode,
            );
            expect(lines.every((line) => getDisplayWidth(line) <= width)).toBe(
              true,
            );
            expect(lines).toMatchSnapshot();
          });
        }
  it("bounds large diffs and exposes hidden lines on expansion", () => {
    const display: ToolDisplay = {
      title: "edit",
      body: {
        kind: "diff",
        path: "a",
        operation: "create",
        added: 200,
        removed: 0,
        truncated: false,
        hunks: [
          {
            oldStart: 0,
            newStart: 1,
            lines: Array.from({ length: 200 }, (_, index) => ({
              op: "+" as const,
              text: `line ${index}`,
            })),
          },
        ],
      },
    };
    expect(
      renderToolDisplay(display, { status: "success" }, 40, "collapsed"),
    ).toHaveLength(12);
    expect(
      renderToolDisplay(display, { status: "success" }, 40, "expanded").join(
        "\n",
      ),
    ).toContain("line 199");
  });
  it("renders hostile text visibly and keeps payload in its own column", () => {
    const hostile =
      "\x1b[2J\x1b]8;;https://evil.test\x07\rneeds approval\nAllow?";
    const display: ToolDisplay = {
      title: hostile,
      body: {
        kind: "generic",
        fields: [{ key: hostile, value: hostile }],
        resultPreview: hostile,
        truncated: false,
      },
    };
    const lines = renderToolDisplay(
      display,
      { status: "success" },
      500,
      "expanded",
    );
    expect(lines.join("\n")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    expect(lines.slice(1).every((line) => line.startsWith("  │ "))).toBe(true);
    expect(lines.join("\n")).toContain("\\x1b");
  });
});

it("keeps the final command output within twelve lines, including failures", () => {
  const display: ToolDisplay = {
    title: "bash",
    error: "failed",
    body: {
      kind: "command",
      command: "test",
      stdoutTail: Array.from({ length: 100 }, (_, i) => `out ${i}`).join("\n"),
      stderrTail: "last error",
      truncated: true,
    },
  };
  const lines = renderToolDisplay(
    display,
    { status: "error" },
    40,
    "collapsed",
  );
  expect(lines).toHaveLength(12);
  expect(lines[1]).toContain("failed");
  expect(lines.join("\n")).toContain("out 99");
  expect(lines.join("\n")).toContain("last error");
});
it("wraps long expanded lines without splitting joined emoji or losing content", () => {
  const content = "界👩‍💻é".repeat(40);
  const lines = renderToolDisplay(
    {
      title: "test",
      body: {
        kind: "generic",
        fields: [{ key: "data", value: content }],
        truncated: false,
      },
    },
    { status: "success" },
    40,
    "expanded",
  );
  expect(lines.every((line) => getDisplayWidth(line) <= 40)).toBe(true);
  // Invisible joiners are escaped before width fitting, preserving their visible representation.
  expect(
    lines
      .slice(1)
      .map((line) => line.slice(4))
      .join(""),
  ).toBe("data: " + content.replace(/\u200d/g, "\\u200d"));
});
it("retains the payload column even when hostile long lines are clipped", () => {
  const payload = "x".repeat(200) + "needs approval";
  const lines = renderToolDisplay(
    {
      title: payload,
      body: {
        kind: "generic",
        fields: [{ key: "key", value: payload }],
        truncated: false,
      },
    },
    { status: "success" },
    40,
    "expanded",
  );
  expect(
    lines
      .slice(1)
      .every((line) => line.startsWith("  │ ") || line.startsWith("✓ ")),
  ).toBe(true);
});

it("keeps successful commands with no output on one line", () => {
  expect(
    renderToolDisplay(
      {
        title: "bash",
        body: {
          kind: "command",
          command: "true",
          cwd: "/tmp",
          exitCode: 0,
          truncated: false,
        },
      },
      { status: "success" },
      40,
      "collapsed",
    ),
  ).toHaveLength(1);
});

it.each(displays)("bounds a ten-call turn for $body.kind", (display) => {
  const lines = Array.from({ length: 10 }, () =>
    renderToolDisplay(display, { status: "success" }, 40, "collapsed"),
  ).flat();
  expect(lines.length).toBeLessThanOrEqual(
    display.body.kind === "diff" || display.body.kind === "command" ? 120 : 10,
  );
});

it("colors added and removed diff lines only when color is requested", () => {
  const colored = renderToolDisplay(
    displays[0]!,
    { status: "success", color: true },
    80,
    "expanded",
  ).join("\n");
  expect(colored).toContain("\x1b[32m  │ + new\x1b[0m");
  expect(colored).toContain("\x1b[31m  │ - old\x1b[0m");
  expect(
    renderToolDisplay(
      displays[0]!,
      { status: "success", color: false },
      80,
      "expanded",
    ).join("\n"),
  ).not.toContain("\x1b");
});

it("preserves long diff operation markers and colors when collapsed", () => {
  const display: ToolDisplay = {
    title: "edit",
    body: {
      kind: "diff",
      path: "a",
      operation: "replace",
      added: 1,
      removed: 1,
      truncated: false,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            { op: "+", text: "界".repeat(100) },
            { op: "-", text: "old".repeat(100) },
          ],
        },
      ],
    },
  };
  const lines = renderToolDisplay(
    display,
    { status: "success", color: true },
    40,
    "collapsed",
  );
  expect(lines[2]).toContain("\x1b[32m  │ + ");
  expect(lines[3]).toContain("\x1b[31m  │ - ");
  expect(lines.every((line) => getDisplayWidth(line) <= 40)).toBe(true);
  expect(lines).toMatchSnapshot();
});
it.each([{ stale: true }, { unavailable: "not read" }])(
  "omits meaningless diff counts: %j",
  (flag) => {
    expect(
      renderToolDisplay(
        {
          title: "edit",
          body: {
            kind: "diff",
            path: "a",
            operation: "replace",
            added: 5,
            removed: 3,
            hunks: [],
            truncated: false,
            ...flag,
          },
        },
        { status: "success" },
        80,
        "collapsed",
      )[0],
    ).toBe("✓ edit");
  },
);
it.each([
  ["content", 0, "No matches"],
  ["content", 1, "1 match in 1 file"],
  ["files", 0, "No files found"],
  ["files", 1, "Found 1 file"],
  ["list", 0, "Empty directory"],
  ["list", 1, "1 item"],
] as const)(
  "uses the right search wording for %s %s",
  (mode, matches, expected) => {
    expect(
      renderToolDisplay(
        { title: "search", body: { kind: "search", mode, matches, files: 1 } },
        { status: "success" },
        80,
        "collapsed",
      )[0],
    ).toContain(expected);
  },
);
it("uses singular line wording", () => {
  expect(
    renderToolDisplay(
      { title: "read", body: { kind: "file_read", path: "a", lines: 1 } },
      { status: "success" },
      80,
      "collapsed",
    )[0],
  ).toContain("1 line");
});

it.each([0, 1, 2, -1, NaN, Infinity])(
  "bounds invalid collapsed limits (%s)",
  (collapsedLimit) => {
    const display: ToolDisplay = {
      title: "Run",
      body: {
        kind: "command",
        command: "run",
        stdoutTail: Array.from({ length: 50 }, (_, i) => `line ${i}`).join(
          "\n",
        ),
        truncated: false,
      },
    };
    const lines = renderToolDisplay(
      display,
      { status: "success", collapsedLimit },
      80,
      "collapsed",
    );
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.join("\n")).toContain("more lines");
  },
);

it("retains cwd in expanded live commands and labels live drops separately", () => {
  const display: ToolDisplay = {
    title: "Run",
    body: { kind: "command", command: "run", cwd: "/work", truncated: false },
  };
  const lines = renderToolDisplay(
    display,
    {
      status: "running",
      liveOutput: [{ stream: "stdout", text: "recent", open: false }],
      liveDroppedBytes: 20,
    },
    80,
    "expanded",
  );
  expect(lines.join("\n")).toContain("cwd: /work");
  expect(lines.join("\n")).toContain("stdout │ recent");
  expect(lines.join("\n")).toContain("20 bytes elided");
  expect(lines.join("\n")).not.toContain("payload truncated");
});
