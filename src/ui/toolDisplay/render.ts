import type { ToolDisplay, ToolDisplayBody } from "../../tools/display.js";
import { getDisplayWidth, keepEndWithinDisplayWidth } from "../displayWidth.js";
import { visibleText } from "../visibleText.js";

export interface DisplayState {
  status: "running" | "success" | "error";
  durationMs?: number;
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
    ...(display.error
      ? [`error: ${visibleText(display.error.split("\n")[0]!)}`]
      : []),
    ...body.details,
  ];
  if ("truncated" in display.body && display.body.truncated)
    details.push("… payload truncated");
  const lines = layoutLines(display, header, details, mode);
  return fitLines(lines, width, mode, status);
}

function fitLines(
  lines: string[],
  width: number,
  mode: DisplayMode,
  status: string,
): string[] {
  const columns = Math.max(1, Math.floor(width));
  return lines.flatMap((line) => {
    const prefix = line.startsWith("  │ ") ? "  │ " : `${status} `;
    const content = line.slice(prefix.length);
    if (columns <= getDisplayWidth(prefix)) return [prefix.slice(0, columns)];
    const room = columns - getDisplayWidth(prefix);
    if (mode === "collapsed")
      return [prefix + keepEndWithinDisplayWidth(content, room)];
    const chunks: string[] = [];
    let chunk = "";
    for (const segment of content) {
      if (chunk && getDisplayWidth(chunk + segment) > room) {
        chunks.push(prefix + chunk);
        chunk = "";
      }
      chunk += getDisplayWidth(segment) > room ? "…" : segment;
    }
    chunks.push(prefix + chunk);
    return chunks;
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
    const shown = details.length > 11 ? details.slice(0, 10) : details;
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
