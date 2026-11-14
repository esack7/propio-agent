import type { ToolDisplay, ToolDisplayBody } from "../../tools/display.js";
import {
  getDisplayWidth,
  keepEndWithinDisplayWidth,
  wrapVisibleText,
} from "../displayWidth.js";
import { visibleText } from "../visibleText.js";

export interface DisplayState {
  status: "running" | "success" | "error";
  durationMs?: number;
  color?: boolean;
}
export type DisplayMode = "collapsed" | "expanded";
interface Lines {
  summary: string;
  details: string[];
}

function diff(body: Extract<ToolDisplayBody, { kind: "diff" }>): Lines {
  const details = body.stale
    ? ["Preview is stale; file changed before execution"]
    : body.unavailable
      ? [visibleText(body.unavailable)]
      : body.hunks.flatMap((hunk) => [
          `@@ -${hunk.oldStart} +${hunk.newStart} @@`,
          ...hunk.lines.flatMap((line) => {
            const text = `${line.op} ${visibleText(line.text)}${line.truncated ? " …" : ""}`;
            return line.noNewline
              ? [text, "\\ No newline at end of file"]
              : [text];
          }),
        ]);
  return { summary: `+${body.added} −${body.removed}`, details };
}
function command(body: Extract<ToolDisplayBody, { kind: "command" }>): Lines {
  const details = [
    ...(body.cwd ? [`cwd: ${visibleText(body.cwd)}`] : []),
    ...streamLines(body.stdoutTail, "stdout"),
    ...streamLines(body.stderrTail, "stderr"),
  ];
  return {
    summary: `$ ${visibleText(body.command)}${body.exitCode === undefined ? "" : ` · exit ${body.exitCode}`}`,
    details,
  };
}
function streamLines(text: string | undefined, stream: string): string[] {
  return text
    ? text.split("\n").map((line) => `${stream} │ ${visibleText(line)}`)
    : [];
}
function fileRead(
  body: Extract<ToolDisplayBody, { kind: "file_read" }>,
): Lines {
  return {
    summary: body.lines === undefined ? "" : `${body.lines} lines`,
    details: [
      `path: ${visibleText(body.path)}`,
      ...(body.range
        ? [
            `range: ${body.range.start}${body.range.count === undefined ? "" : `, count ${body.range.count}`}`,
          ]
        : []),
    ],
  };
}
function search(body: Extract<ToolDisplayBody, { kind: "search" }>): Lines {
  return {
    summary: [
      body.matches === undefined ? "" : `${body.matches} matches`,
      body.files === undefined ? "" : `${body.files} files`,
    ]
      .filter(Boolean)
      .join(" in "),
    details: [
      ...(body.pattern === undefined
        ? []
        : [`pattern: ${visibleText(body.pattern)}`]),
      ...(body.scope === undefined
        ? []
        : [`scope: ${visibleText(body.scope)}`]),
      ...(body.sample ?? []).map(visibleText),
    ],
  };
}
function generic(body: Extract<ToolDisplayBody, { kind: "generic" }>): Lines {
  return {
    summary: body.resultPreview
      ? visibleText(body.resultPreview.split("\n")[0]!)
      : "",
    details: [
      ...body.fields.map(
        (field) => `${visibleText(field.key)}: ${visibleText(field.value)}`,
      ),
      ...streamLines(body.resultPreview, "result"),
    ],
  };
}
function bodyLines(body: ToolDisplayBody): Lines {
  switch (body.kind) {
    case "diff":
      return diff(body);
    case "command":
      return command(body);
    case "file_read":
      return fileRead(body);
    case "search":
      return search(body);
    case "generic":
      return generic(body);
  }
}

/** Only renderer-owned prefixes and styling escape the visible-text boundary. */
export function renderToolDisplay(
  display: ToolDisplay,
  state: DisplayState,
  width: number,
  mode: DisplayMode,
): string[] {
  const body = bodyLines(display.body);
  const status =
    state.status === "running" ? "◆" : state.status === "success" ? "✓" : "✗";
  const timing =
    state.durationMs === undefined
      ? ""
      : ` · ${(state.durationMs / 1000).toFixed(1)}s`;
  const title =
    display.body.kind === "command"
      ? body.summary
      : [visibleText(display.title), body.summary].filter(Boolean).join(" · ");
  const header = `${status} ${title}${timing}`;
  const details = [
    ...(display.fullOutputPath
      ? [`Full output: ${visibleText(display.fullOutputPath)}`]
      : []),
    ...(display.error
      ? [
          `error: ${visibleText(mode === "expanded" ? display.error : display.error.split("\n")[0]!)}`,
        ]
      : []),
    ...body.details.filter(
      (line) =>
        mode === "expanded" ||
        display.body.kind !== "command" ||
        !line.startsWith("cwd: "),
    ),
  ];
  if ("truncated" in display.body && display.body.truncated)
    details.push("… payload truncated");
  const lines = layoutLines(display, header, details, mode);
  const fitted = fitLines(lines, width, mode, status);
  if (!state.color || display.body.kind !== "diff") return fitted;
  return fitted.map((line) =>
    line.startsWith("  │ + ")
      ? `\x1b[32m${line}\x1b[0m`
      : line.startsWith("  │ - ")
        ? `\x1b[31m${line}\x1b[0m`
        : line,
  );
}

function fitLines(
  lines: string[],
  width: number,
  mode: DisplayMode,
  status: string,
): string[] {
  const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
  return lines.flatMap((line) => {
    const prefix = line.startsWith("  │ ") ? "  │ " : `${status} `;
    const content = line.slice(prefix.length);
    if (columns <= getDisplayWidth(prefix)) return [prefix.slice(0, columns)];
    const room = columns - getDisplayWidth(prefix);
    if (mode === "collapsed")
      return [prefix + keepEndWithinDisplayWidth(content, room)];
    return wrapVisibleText(content, room).map((chunk) => prefix + chunk);
  });
}

function layoutLines(
  display: ToolDisplay,
  header: string,
  details: string[],
  mode: DisplayMode,
): string[] {
  let lines: string[];
  if (mode === "expanded")
    lines = [header, ...details.map((line) => `  │ ${line}`)];
  else if (display.body.kind === "diff" || display.body.kind === "command") {
    const shown = collapsedDetails(display, details);
    lines = [header, ...shown.map((line) => `  │ ${line}`)];
    if (details.length > 11)
      lines.push(`  │ … ${details.length - 10} more lines`);
  } else
    lines = [
      header,
      ...(display.error
        ? [`  │ error: ${visibleText(display.error.split("\n")[0]!)}`]
        : []),
    ];
  return lines;
}

function collapsedDetails(display: ToolDisplay, details: string[]): string[] {
  const limit = details.length > 11 ? 10 : 11;
  return display.body.kind === "command" && details.length > limit
    ? [
        ...(display.error ? [details[0]!] : []),
        ...details.slice(-(limit - (display.error ? 1 : 0))),
      ]
    : details.slice(0, limit);
}
