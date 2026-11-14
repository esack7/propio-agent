import type { ToolMetadata } from "../policy/capabilities.js";
import type { PathToolOptions } from "./localOptions.js";
import type { ToolExecutionContext } from "./execution.js";
import type { ToolExecutionResult } from "./types.js";
import * as fsPromises from "fs/promises";
import { PresentedTool } from "./interface.js";
import type { ToolDisplay } from "./display.js";
import type { ToolDescribeContext } from "./interface.js";
import {
  createContentHash,
  finishFileChange,
  previewFileChange,
} from "./fileChangeDisplay.js";
import { ChatTool } from "@propio-ai/providers";
import {
  getPathToolInvocationLabel,
  normalizeToolPath,
  throwFileOperationError,
  readUtf8TextFile,
  throwToolPathAccessError,
  toStringArg,
  writeFileAtomically,
} from "./shared.js";

function throwEditFileSystemError(
  err: NodeJS.ErrnoException | Error,
  rawPath: unknown,
): void {
  if (!("code" in err)) {
    return;
  }

  if (err.code === "ENOENT") {
    throw new Error(`File not found: ${rawPath}`);
  }

  throwToolPathAccessError(err, rawPath);
}

/**
 * The text an edit leaves, and how many places it changed. Throws when the
 * edit cannot be made. Describing a call and running it both use this.
 */
function applyEdit(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { updated: string; occurrences: number } {
  if (oldString.length === 0)
    throw new Error("old_string must be a non-empty string");
  const occurrences = original.split(oldString).length - 1;
  if (occurrences === 0)
    throw new Error(`String not found in file: ${oldString}`);
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `Multiple matches found for edit; set replace_all to true: ${oldString}`,
    );
  }
  return {
    updated: replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString),
    occurrences,
  };
}

export class EditTool implements PresentedTool {
  readonly name = "edit";
  readonly metadata: ToolMetadata = {
    capabilities: ["workspace_write"],
    readOnly: false,
    concurrencySafe: false,
  };
  readonly description = "Edit a file - replace text.";

  private readonly resolvePath: (rawPath: unknown) => string;

  constructor(options?: PathToolOptions) {
    this.resolvePath = options?.resolvePath ?? normalizeToolPath;
  }

  describeCall(
    args: Readonly<Record<string, unknown>>,
    context?: ToolDescribeContext,
  ): Promise<ToolDisplay> {
    return previewFileChange({
      title: getPathToolInvocationLabel(args, "Editing", "Editing file"),
      rawPath: args.path,
      resolvePath: this.resolvePath,
      context,
      next: (original) => {
        if (original === undefined) {
          throw new Error(`File not found: ${String(args.path)}`);
        }
        return applyEdit(
          original,
          toStringArg(args.old_string, "old_string"),
          toStringArg(args.new_string, "new_string"),
          args.replace_all === true,
        ).updated;
      },
    });
  }

  describeResult(
    args: Readonly<Record<string, unknown>>,
    result: Readonly<ToolExecutionResult>,
    before: ToolDisplay,
  ): ToolDisplay {
    return finishFileChange(
      getPathToolInvocationLabel(args, "Editing", "Editing file"),
      args.path,
      result,
      before,
    );
  }

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "edit",
        description:
          "Edits an existing text file by replacing exact string matches. Fails when the match is missing or ambiguous unless replace_all is true. Do not use edit for throwaway scratch scripts; use the scratchpad with write or inline shell instead.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file to edit",
            },
            old_string: {
              type: "string",
              description: "Exact string to replace",
            },
            new_string: {
              type: "string",
              description: "Replacement string",
            },
            replace_all: {
              type: "boolean",
              description:
                "Replace every occurrence instead of requiring a single match",
              default: false,
            },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    };
  }

  private rethrowKnownEditMessageErrors(err: Error): void {
    if (err.message.startsWith("String not found")) throw err;
    if (err.message === "old_string must be a non-empty string") throw err;
    if (err.message.startsWith("Multiple matches found for edit")) throw err;
    if (err.message.startsWith("Path is")) throw err;
  }

  private classifyEditError(error: unknown, rawPath: unknown): never {
    const err = error as NodeJS.ErrnoException | Error;
    if (err instanceof Error) {
      this.rethrowKnownEditMessageErrors(err);
    }
    throwEditFileSystemError(err, rawPath);
    throwFileOperationError(error, "edit");
  }

  async executeWithStatus(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolExecutionResult> {
    context.signal?.throwIfAborted();
    const rawPath = args.path;
    const oldString = toStringArg(args.old_string, "old_string");
    const newString = toStringArg(args.new_string, "new_string");
    const replaceAll = args.replace_all === true;
    const path = this.resolvePath(rawPath);

    try {
      const stats = await fsPromises.stat(path);
      if (stats.isDirectory())
        throw new Error(`Path is a directory, not a file: ${rawPath}`);
      const original = await readUtf8TextFile(path);
      const { updated, occurrences } = applyEdit(
        original,
        oldString,
        newString,
        replaceAll,
      );

      context.signal?.throwIfAborted();
      await writeFileAtomically(path, updated);
      return {
        status: "success",
        content: replaceAll
          ? `Edited file: ${rawPath} (${occurrences} replacements)`
          : `Edited file: ${rawPath} (1 replacement)`,
        outcome: {
          kind: "file_edit",
          classification: "succeeded",
          resolvedPath: path,
          operation: "replace",
          beforeHash: createContentHash(original),
          afterHash: createContentHash(updated),
          sideEffect: "completed",
        },
      };
    } catch (error) {
      this.classifyEditError(error, rawPath);
    }
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    return (await this.executeWithStatus(args, context)).content;
  }
}
