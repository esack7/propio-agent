import type { ToolMetadata } from "../policy/capabilities.js";
import type { PathToolOptions } from "./localOptions.js";
import type { ToolExecutionContext } from "./execution.js";
import { PresentedTool } from "./interface.js";
import type { SearchDisplay, ToolDisplay } from "./display.js";
import { describeSearchCall, describeSearchResult } from "./searchDisplay.js";
import type { ToolExecutionResult } from "./types.js";
import { ChatTool } from "@propio-ai/providers";
import {
  collectFilesForSearch,
  normalizeToolPath,
  readUtf8TextFile,
} from "./shared.js";

export interface GrepToolConfig extends PathToolOptions {
  readonly outputInlineLimit?: number;
}

function createLineMatcher(
  pattern: string,
  useRegex: boolean,
): (line: string) => boolean {
  if (!useRegex) {
    return (line) => line.includes(pattern);
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new Error(
      `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return (line) => {
    regex.lastIndex = 0;
    return regex.test(line);
  };
}

async function collectFileMatches(
  filePath: string,
  matchesLine: (line: string) => boolean,
): Promise<string[]> {
  try {
    const content = await readUtf8TextFile(filePath);
    return content
      .split(/\r?\n/)
      .flatMap((line, index) =>
        matchesLine(line) ? [`${filePath}:${index + 1}:${line}`] : [],
      );
  } catch {
    return [];
  }
}

function grepTitle(args: Readonly<Record<string, unknown>>): string {
  const path = typeof args.path === "string" ? args.path : "";
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (path.length === 0) {
    return pattern.length > 0
      ? `Searching for ${JSON.stringify(pattern)}`
      : "Searching files";
  }
  return pattern.length > 0
    ? `Searching ${path} for ${JSON.stringify(pattern)}`
    : `Searching ${path}`;
}

export class GrepTool implements PresentedTool {
  readonly name = "grep";
  readonly metadata: ToolMetadata = {
    capabilities: ["read"],
    readOnly: true,
    concurrencySafe: true,
  };
  readonly description = "Search file contents recursively.";
  private readonly outputInlineLimit: number;

  private readonly resolvePath: (rawPath: unknown) => string;

  constructor(config?: GrepToolConfig) {
    this.resolvePath = config?.resolvePath ?? normalizeToolPath;
    this.outputInlineLimit = config?.outputInlineLimit ?? 50 * 1024;
  }

  describeCall(
    args: Readonly<Record<string, unknown>>,
  ): ToolDisplay<SearchDisplay> {
    return describeSearchCall(grepTitle(args), "content", args);
  }

  describeResult(
    args: Readonly<Record<string, unknown>>,
    result: Readonly<ToolExecutionResult>,
  ): ToolDisplay<SearchDisplay> {
    return describeSearchResult(
      this.describeCall(args),
      result,
      "No matches found",
    );
  }

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "grep",
        description:
          "Recursively searches file contents under a path and returns file:line:content matches. Supports literal and regex mode.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Root file or directory to search",
            },
            pattern: {
              type: "string",
              description: "Text or regex pattern to search for",
            },
            regex: {
              type: "boolean",
              description: "Treat pattern as a regular expression",
              default: false,
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
    const pattern = args.pattern;
    const useRegex = args.regex === true;

    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("pattern must be a non-empty string");
    }

    const rootPath = this.resolvePath(rawPath);

    const matchesLine = createLineMatcher(pattern, useRegex);

    const files = await collectFilesForSearch(rootPath);
    const matches: string[] = [];
    for (const filePath of files) {
      context.signal?.throwIfAborted();
      matches.push(...(await collectFileMatches(filePath, matchesLine)));
    }

    if (matches.length === 0) {
      return `No matches found for pattern: ${pattern}`;
    }

    return matches.join("\n");
  }
}
