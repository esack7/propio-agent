import type { ToolMetadata } from "../policy/capabilities.js";
import type { PathToolOptions } from "./localOptions.js";
import type { ToolExecutionContext } from "./execution.js";
import * as fsPromises from "fs/promises";
import { PresentedTool } from "./interface.js";
import type { SearchDisplay, ToolDisplay } from "./display.js";
import { describeSearchCall, describeSearchResult } from "./searchDisplay.js";
import type { ToolExecutionResult } from "./types.js";
import { ChatTool } from "@propio-ai/providers";
import { listContainedFiles } from "./containedFiles.js";
import { normalizeToolPath, throwDirectoryOperationError } from "./shared.js";

function recursivePattern(pattern: string): string {
  if (pattern.includes("/")) {
    return pattern;
  }

  return `**/${pattern}`;
}

function findTitle(args: Readonly<Record<string, unknown>>): string {
  const path = typeof args.path === "string" ? args.path : "";
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  const matching =
    pattern.length > 0 ? ` matching ${JSON.stringify(pattern)}` : "";
  return path.length > 0
    ? `Finding files in ${path}${matching}`
    : `Finding files${matching}`;
}

export class FindTool implements PresentedTool {
  readonly name = "find";
  readonly metadata: ToolMetadata = {
    capabilities: ["read"],
    readOnly: true,
    concurrencySafe: true,
  };
  readonly description = "Find files by name or glob.";

  private readonly resolvePath: (rawPath: unknown) => string;

  constructor(options?: PathToolOptions) {
    this.resolvePath = options?.resolvePath ?? normalizeToolPath;
  }

  describeCall(
    args: Readonly<Record<string, unknown>>,
  ): ToolDisplay<SearchDisplay> {
    return describeSearchCall(findTitle(args), "files", args);
  }

  describeResult(
    args: Readonly<Record<string, unknown>>,
    result: Readonly<ToolExecutionResult>,
  ): ToolDisplay<SearchDisplay> {
    return describeSearchResult(
      this.describeCall(args),
      result,
      "No files found",
    );
  }

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "find",
        description:
          "Recursively finds file paths under a root directory using a filename or glob pattern.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Root directory to search",
            },
            pattern: {
              type: "string",
              description: "Filename or glob pattern to match",
            },
          },
          required: ["path", "pattern"],
        },
      },
    };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<string> {
    context.signal?.throwIfAborted();
    const rawPath = args.path;
    const rawPattern = args.pattern;

    if (typeof rawPattern !== "string" || rawPattern.length === 0) {
      throw new Error("pattern must be a non-empty string");
    }

    const path = this.resolvePath(rawPath);

    try {
      const stats = await fsPromises.stat(path);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${rawPath}`);
      }

      const matches = await listContainedFiles(
        path,
        recursivePattern(rawPattern),
      );

      if (matches.length === 0) {
        return `No files found matching pattern: ${rawPattern}`;
      }

      return matches.sort().join("\n");
    } catch (error) {
      throwDirectoryOperationError(error, rawPath, "find files");
    }
  }
}
