import fg from "fast-glob";
import * as fsPromises from "fs/promises";
import { ExecutableTool } from "./interface.js";
import { ChatTool } from "../providers/types.js";
import { normalizeToolPath } from "./shared.js";

function recursivePattern(pattern: string): string {
  if (pattern.includes("/")) {
    return pattern;
  }

  return `**/${pattern}`;
}

export class FindTool implements ExecutableTool {
  readonly name = "find";
  readonly description = "Find files by name or glob.";

  getInvocationLabel(args: Record<string, unknown>): string | undefined {
    const path = args.path;
    const pattern = args.pattern;
    if (typeof path === "string" && path.length > 0) {
      if (typeof pattern === "string" && pattern.length > 0) {
        return `Finding files in ${path} matching ${JSON.stringify(pattern)}`;
      }
      return `Finding files in ${path}`;
    }

    return typeof pattern === "string" && pattern.length > 0
      ? `Finding files matching ${JSON.stringify(pattern)}`
      : "Finding files";
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

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawPath = args.path;
    const rawPattern = args.pattern;

    if (typeof rawPattern !== "string" || rawPattern.length === 0) {
      throw new Error("pattern must be a non-empty string");
    }

    const path = normalizeToolPath(rawPath);

    try {
      const stats = await fsPromises.stat(path);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${rawPath}`);
      }

      const matches = await fg(recursivePattern(rawPattern), {
        cwd: path,
        absolute: true,
        onlyFiles: true,
        dot: false,
      });

      if (matches.length === 0) {
        return `No files found matching pattern: ${rawPattern}`;
      }

      return matches.sort().join("\n");
    } catch (error) {
      const err = error as NodeJS.ErrnoException | Error;

      if (err instanceof Error && err.message.startsWith("Path is not a")) {
        throw err;
      }
      if ("code" in err && err.code === "ENOENT") {
        throw new Error(`Directory not found: ${rawPath}`);
      }
      if ("code" in err && (err.code === "EACCES" || err.code === "EPERM")) {
        throw new Error(`Permission denied: ${rawPath}`);
      }

      throw new Error(`Failed to find files: ${err.message || String(error)}`);
    }
  }
}
