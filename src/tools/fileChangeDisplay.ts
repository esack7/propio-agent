import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import {
  DISPLAY_LIMITS,
  displayTitle,
  withFailure,
  type DiffDisplay,
  type ToolDisplay,
} from "./display.js";
import type { ToolDescribeContext } from "./interface.js";
import { diffLines } from "./lineDiff.js";
import { readUtf8TextFile } from "./shared.js";
import type { ToolExecutionResult } from "./types.js";

/** Larger files are changed without a preview rather than read twice. */
const PREVIEW_MAX_BYTES = 1024 * 1024;

/**
 * How long the diff may search for the smallest change. The search is
 * synchronous, so this bounds how long a preview holds up the call; the
 * runtime's own budget for a description is 250 ms.
 */
const PREVIEW_DIFF_BUDGET_MS = 50;

export function createContentHash(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function withoutHunks(
  path: string,
  detail: Pick<DiffDisplay, "unavailable" | "stale"> &
    Partial<Pick<DiffDisplay, "operation">>,
): DiffDisplay {
  return {
    kind: "diff",
    path,
    operation: detail.operation ?? "replace",
    hunks: [],
    added: 0,
    removed: 0,
    truncated: false,
    ...(detail.unavailable === undefined
      ? {}
      : { unavailable: detail.unavailable }),
    ...(detail.stale ? { stale: true } : {}),
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The file's text, or undefined when there is no file. Throws when it cannot be shown. */
async function readForPreview(path: string): Promise<string | undefined> {
  let stats: Awaited<ReturnType<typeof fsPromises.stat>>;
  try {
    stats = await fsPromises.stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (stats.isDirectory()) throw new Error("Path is a directory");
  if (stats.size > PREVIEW_MAX_BYTES) {
    throw new Error("File is too large to preview");
  }
  return await readUtf8TextFile(path);
}

/**
 * Describe a change to one file before it is made: read the file as it is,
 * work out what the call would leave, and diff the two. Nothing is written.
 * When the change cannot be shown, the description says why and has no hunks.
 */
export async function previewFileChange(options: {
  readonly title: string;
  readonly rawPath: unknown;
  readonly resolvePath: (rawPath: unknown) => string;
  readonly context?: ToolDescribeContext;
  /** The content the call would leave. Throws when the call would fail. */
  next(original: string | undefined): string;
}): Promise<ToolDisplay> {
  const title = displayTitle(options.title);
  const rawPath = typeof options.rawPath === "string" ? options.rawPath : "";
  const unavailable = (why: string): ToolDisplay => ({
    title,
    body: withoutHunks(rawPath, { unavailable: why }),
  });
  if (rawPath.length === 0) return unavailable("No path given");
  try {
    if (
      options.context?.canPreviewRead &&
      !(await options.context.canPreviewRead(rawPath))
    ) {
      return unavailable("Not read before approval");
    }
    const original = await readForPreview(options.resolvePath(rawPath));
    const updated = options.next(original);
    const diff = diffLines(original ?? "", updated, {
      maxLines: DISPLAY_LIMITS.diffLines,
      maxBytes: DISPLAY_LIMITS.diffBytes,
      deadline: {
        at: performance.now() + PREVIEW_DIFF_BUDGET_MS,
        now: () => performance.now(),
      },
    });
    return {
      title,
      body: {
        kind: "diff",
        path: rawPath,
        operation: original === undefined ? "create" : "replace",
        hunks: diff.hunks,
        added: diff.added,
        removed: diff.removed,
        truncated: diff.truncated,
        ...(original === undefined
          ? {}
          : { baseHash: createContentHash(original) }),
      },
    };
  } catch (error) {
    return unavailable(reason(error));
  }
}

/**
 * The description of a file change once the call has a result. The preview's
 * hunks are kept only if the file was still what they were computed against.
 */
export function finishFileChange(
  title: string,
  rawPath: unknown,
  result: Readonly<ToolExecutionResult>,
  before: ToolDisplay,
): ToolDisplay {
  const path = typeof rawPath === "string" ? rawPath : "";
  const body: DiffDisplay =
    before.body.kind === "diff"
      ? before.body
      : withoutHunks(path, { unavailable: "No preview was made" });
  const display: ToolDisplay = { title: displayTitle(title), body };
  if (result.status !== "success") return withFailure(display, result.content);
  const outcome = result.outcome;
  if (outcome?.kind !== "file_write" && outcome?.kind !== "file_edit") {
    return display;
  }
  if (body.unavailable !== undefined) {
    return { ...display, body: { ...body, operation: outcome.operation } };
  }
  if (body.baseHash !== outcome.beforeHash) {
    return {
      ...display,
      body: withoutHunks(path, { stale: true, operation: outcome.operation }),
    };
  }
  return display;
}
