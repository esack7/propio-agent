import type { CommandOutcomeClassification } from "./types.js";

/**
 * What a tool call is, as data a frontend can draw.
 *
 * A tool describes its call before it runs and again when it has a result.
 * The runtime carries the description on tool events; a terminal, a browser,
 * or a replay renders it. Every field is a string, number, or boolean, so a
 * payload is plain JSON. It is for people: the model still receives the
 * tool's full result.
 */
export interface ToolDisplay<Body extends ToolDisplayBody = ToolDisplayBody> {
  /** The activity in a few words, such as "Editing src/a.ts". */
  readonly title: string;
  readonly body: Body;
  /** Why the call failed, when it did. */
  readonly error?: string;
}

export type ToolDisplayBody =
  | DiffDisplay
  | CommandDisplay
  | FileReadDisplay
  | SearchDisplay
  | GenericDisplay;

export interface DiffLine {
  readonly op: " " | "+" | "-";
  readonly text: string;
}

export interface DiffHunk {
  /** 1-based line where the hunk starts in the old text; 0 for an empty side. */
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly DiffLine[];
}

export interface DiffDisplay {
  readonly kind: "diff";
  /** The path as the caller gave it. */
  readonly path: string;
  readonly operation: "create" | "replace";
  readonly hunks: readonly DiffHunk[];
  readonly added: number;
  readonly removed: number;
  /** Lines were left out to keep the payload small. */
  readonly truncated: boolean;
  /**
   * Hash of the content the hunks were computed against. A description made
   * before the call uses it to tell whether the file changed in between.
   */
  readonly baseHash?: string;
  /** The file was not what the hunks were computed against; they are omitted. */
  readonly stale?: boolean;
  /** Why no hunks could be shown, such as a binary or unreadable file. */
  readonly unavailable?: string;
}

export interface CommandDisplay {
  readonly kind: "command";
  readonly command: string;
  readonly cwd?: string;
  readonly exitCode?: number;
  readonly classification?: CommandOutcomeClassification;
  /** The last lines written to each stream. */
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  /** Non-empty lines written to each stream, before any cut. */
  readonly stdoutLines?: number;
  readonly stderrLines?: number;
  /** A tail holds less than the stream wrote. */
  readonly truncated: boolean;
}

export interface FileReadDisplay {
  readonly kind: "file_read";
  readonly path: string;
  /** The lines asked for, when the call asked for a range. */
  readonly range?: { readonly start: number; readonly count?: number };
  /** Lines returned. */
  readonly lines?: number;
}

export interface SearchDisplay {
  readonly kind: "search";
  /** Lines matching a pattern, file names matching one, or a directory listing. */
  readonly mode: "content" | "files" | "list";
  readonly pattern?: string;
  readonly scope?: string;
  /** Matching lines, files found, or entries listed. */
  readonly matches?: number;
  /** Distinct files holding the matches, for a content search. */
  readonly files?: number;
  /** The first few results. */
  readonly sample?: readonly string[];
}

export interface GenericDisplay {
  readonly kind: "generic";
  readonly fields: readonly { readonly key: string; readonly value: string }[];
  readonly resultPreview?: string;
  /** A value or the preview was cut. */
  readonly truncated: boolean;
}

export const DISPLAY_LIMITS = Object.freeze({
  diffLines: 400,
  tailLines: 200,
  tailBytes: 16 * 1024,
  genericValueChars: 2000,
  genericFields: 40,
  sampleItems: 5,
  sampleItemChars: 300,
  titleChars: 200,
  errorChars: 2000,
});

function cut(text: string, limit: number): { text: string; cut: boolean } {
  return text.length <= limit
    ? { text, cut: false }
    : { text: text.slice(0, limit), cut: true };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A title no longer than the limit. */
export function displayTitle(text: string): string {
  return cut(text, DISPLAY_LIMITS.titleChars).text;
}

/**
 * The description used for a tool that supplies none, and whenever a tool's
 * own description fails: one field per top-level argument.
 */
export function genericDisplay(
  title: string,
  args: Readonly<Record<string, unknown>> | undefined,
  result?: { readonly content: string; readonly failed: boolean },
): ToolDisplay {
  let truncated = false;
  const entries = Object.entries(args ?? {});
  if (entries.length > DISPLAY_LIMITS.genericFields) truncated = true;
  const fields = entries
    .slice(0, DISPLAY_LIMITS.genericFields)
    .map(([key, raw]) => {
      const value = cut(stringify(raw), DISPLAY_LIMITS.genericValueChars);
      if (value.cut) truncated = true;
      return {
        key: cut(key, DISPLAY_LIMITS.titleChars).text,
        value: value.text,
      };
    });
  const body: GenericDisplay = { kind: "generic", fields, truncated };
  if (result === undefined) return { title: displayTitle(title), body };
  const preview = cut(result.content, DISPLAY_LIMITS.genericValueChars);
  return withFailure(
    {
      title: displayTitle(title),
      body: {
        ...body,
        ...(result.failed ? {} : { resultPreview: preview.text }),
        truncated: truncated || (!result.failed && preview.cut),
      },
    },
    result.failed ? result.content : undefined,
  );
}

/** The same description, marked as failed with the given reason. */
export function withFailure<Body extends ToolDisplayBody>(
  display: ToolDisplay<Body>,
  error: string | undefined,
): ToolDisplay<Body> {
  if (error === undefined) return display;
  return { ...display, error: cut(error, DISPLAY_LIMITS.errorChars).text };
}

/** The last lines of a stream, within the line and byte limits. */
export function outputTail(output: string): {
  tail: string;
  lines: number;
  truncated: boolean;
} {
  const trimmed = output.replace(/\n+$/, "");
  const all = trimmed.length === 0 ? [] : trimmed.split("\n");
  const lines = all.filter((line) => line.trim().length > 0).length;
  let kept = all.slice(-DISPLAY_LIMITS.tailLines);
  let truncated = kept.length < all.length;
  let tail = kept.join("\n");
  while (tail.length > DISPLAY_LIMITS.tailBytes && kept.length > 1) {
    kept = kept.slice(1);
    tail = kept.join("\n");
    truncated = true;
  }
  if (tail.length > DISPLAY_LIMITS.tailBytes) {
    tail = tail.slice(-DISPLAY_LIMITS.tailBytes);
    truncated = true;
  }
  return { tail, lines, truncated };
}

/** The first few results of a search, each cut to a line's worth. */
export function searchSample(items: readonly string[]): string[] {
  return items
    .slice(0, DISPLAY_LIMITS.sampleItems)
    .map((item) => cut(item, DISPLAY_LIMITS.sampleItemChars).text);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function compactPreview(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}...`;
}

function searchUseLabel(body: SearchDisplay): string | null {
  const pattern =
    body.mode === "content" && body.pattern !== undefined
      ? JSON.stringify(body.pattern)
      : body.pattern;
  if (pattern !== undefined && pattern.length > 0) {
    return body.scope ? `${pattern} in ${body.scope}` : pattern;
  }
  return body.mode === "list" && body.scope ? body.scope : null;
}

/** What the call is acting on, in one line: a path, a command, a pattern. */
export function displayUseLabel(display: ToolDisplay): string | null {
  const body = display.body;
  switch (body.kind) {
    case "diff":
    case "file_read":
      return body.path.length > 0 ? body.path : null;
    case "command":
      return body.command.length > 0 ? body.command : null;
    case "search":
      return searchUseLabel(body);
    case "generic":
      return null;
  }
}

function commandResultLabel(body: CommandDisplay): string | null {
  if (body.exitCode === undefined) return null;
  if (body.exitCode === 0) {
    const lines = body.stdoutLines ?? 0;
    return lines > 0 ? `Exit 0 (${plural(lines, "line", "lines")})` : "Exit 0";
  }
  const stderr = compactPreview(body.stderrTail ?? "", 60);
  return stderr.length === 0
    ? `Exit ${body.exitCode}`
    : `Exit ${body.exitCode}: ${stderr}`;
}

function searchResultLabel(body: SearchDisplay): string | null {
  if (body.matches === undefined) return null;
  if (body.mode === "content") {
    if (body.matches === 0) return "No matches";
    const files = body.files ?? 0;
    return `Found ${plural(body.matches, "match", "matches")} in ${
      files === 1 ? "1 file" : `${files} files`
    }`;
  }
  if (body.mode === "files") {
    return body.matches === 0
      ? "No files found"
      : `Found ${plural(body.matches, "file", "files")}`;
  }
  return body.matches === 0
    ? "Empty directory"
    : plural(body.matches, "item", "items");
}

function diffResultLabel(body: DiffDisplay): string {
  const verb = body.operation === "create" ? "Created" : "Changed";
  if (body.stale || body.unavailable !== undefined) return verb;
  return `${verb} (+${body.added} -${body.removed})`;
}

/** What a finished call produced, in one line. Null when there is nothing to say. */
export function displayResultLabel(display: ToolDisplay): string | null {
  if (display.error !== undefined) return compactPreview(display.error, 120);
  const body = display.body;
  switch (body.kind) {
    case "diff":
      return diffResultLabel(body);
    case "command":
      return commandResultLabel(body);
    case "file_read":
      return body.lines === undefined
        ? null
        : `Read ${plural(body.lines, "line", "lines")}`;
    case "search":
      return searchResultLabel(body);
    case "generic":
      return body.resultPreview === undefined
        ? null
        : compactPreview(body.resultPreview, 120);
  }
}
