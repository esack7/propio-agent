import { ExecutableTool } from "./interface.js";
import { ChatTool } from "../providers/types.js";
import {
  collectFilesForSearch,
  normalizeToolPath,
  readUtf8TextFile,
  truncateText,
} from "./shared.js";

const GREP_OUTPUT_LIMIT = 50 * 1024;

export class GrepTool implements ExecutableTool {
  readonly name = "grep";
  readonly description = "Search file contents recursively.";

  getInvocationLabel(args: Record<string, unknown>): string | undefined {
    const path = args.path;
    const pattern = args.pattern;
    if (typeof path !== "string" || path.length === 0) {
      return typeof pattern === "string" && pattern.length > 0
        ? `Searching for ${JSON.stringify(pattern)}`
        : "Searching files";
    }

    if (typeof pattern === "string" && pattern.length > 0) {
      return `Searching ${path} for ${JSON.stringify(pattern)}`;
    }

    return `Searching ${path}`;
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

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawPath = args.path;
    const pattern = args.pattern;
    const useRegex = args.regex === true;

    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("pattern must be a non-empty string");
    }

    const rootPath = normalizeToolPath(rawPath);

    let matcher: RegExp | null = null;
    if (useRegex) {
      try {
        matcher = new RegExp(pattern);
      } catch (error) {
        throw new Error(
          `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const files = await collectFilesForSearch(rootPath);
    const matches: string[] = [];
    let outputLength = 0;

    for (const filePath of files) {
      try {
        const content = await readUtf8TextFile(filePath);
        const lines = content.split(/\r?\n/);

        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const isMatch = useRegex
            ? (() => {
                matcher!.lastIndex = 0;
                return matcher!.test(line);
              })()
            : line.includes(pattern);

          if (!isMatch) {
            continue;
          }

          const formatted = `${filePath}:${index + 1}:${line}`;
          matches.push(formatted);
          outputLength += formatted.length + 1;

          if (outputLength > GREP_OUTPUT_LIMIT) {
            const truncated = truncateText(
              matches.join("\n"),
              GREP_OUTPUT_LIMIT,
              "[Output truncated - exceeded size limit]",
            );
            return truncated.value;
          }
        }
      } catch {
        continue;
      }
    }

    if (matches.length === 0) {
      return `No matches found for pattern: ${pattern}`;
    }

    return matches.join("\n");
  }
}
