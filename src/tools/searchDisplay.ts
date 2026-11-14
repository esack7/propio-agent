import {
  displayTitle,
  searchSample,
  withFailure,
  type SearchDisplay,
  type ToolDisplay,
} from "./display.js";
import type { ToolExecutionResult } from "./types.js";

/** A search as asked for: what was looked for, and where. */
export function describeSearchCall(
  title: string,
  mode: SearchDisplay["mode"],
  args: Readonly<Record<string, unknown>>,
): ToolDisplay<SearchDisplay> {
  const scope = typeof args.path === "string" ? args.path : "";
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  return {
    title: displayTitle(title),
    body: {
      kind: "search",
      mode,
      ...(pattern && mode !== "list" ? { pattern } : {}),
      ...(scope ? { scope } : {}),
    },
  };
}

/**
 * A search with what it found. The tools return one result per line, or a
 * sentence starting with `emptyPrefix` when there is none.
 */
export function describeSearchResult(
  call: ToolDisplay<SearchDisplay>,
  result: Readonly<ToolExecutionResult>,
  emptyPrefix: string,
): ToolDisplay<SearchDisplay> {
  if (result.status !== "success") return withFailure(call, result.content);
  const found = result.content.startsWith(emptyPrefix)
    ? []
    : result.content
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
  return {
    ...call,
    body: {
      ...call.body,
      matches: found.length,
      ...(call.body.mode === "content"
        ? { files: new Set(found.map((line) => line.split(":")[0])).size }
        : {}),
      sample: searchSample(found),
    },
  };
}
