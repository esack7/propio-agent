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
