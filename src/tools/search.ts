import * as fsPromises from "fs/promises";
import * as path from "path";
import fg from "fast-glob";
import { ExecutableTool } from "./interface.js";
import { ChatTool } from "../providers/types.js";

/**
 * SearchTextTool searches for text within file contents.
 * Supports literal and regex search modes.
 */
export class SearchTextTool implements ExecutableTool {
  readonly name = "search_text";
  private readonly MAX_OUTPUT_LENGTH = 50000; // Truncate output at 50KB

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "search_text",
        description:
          "Searches for a text query within file contents. Supports literal and regex search modes. Returns matching lines with file path and line number.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The text or regex pattern to search for",
            },
            paths: {
              type: "array",
              items: { type: "string" },
              description: "Array of file or directory paths to search in",
            },
            regex: {
              type: "boolean",
              description:
                "If true, treat query as a regular expression. Default: false",
              default: false,
            },
          },
          required: ["query", "paths"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    const paths = args.paths as string[];
    const useRegex = args.regex !== undefined ? (args.regex as boolean) : false;

    // Validate regex if regex mode is enabled
    let pattern: RegExp | null = null;
    if (useRegex) {
      try {
        pattern = new RegExp(query);
      } catch (error) {
        throw new Error(
          `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Collect all files to search
    const filesToSearch: string[] = [];
    for (const searchPath of paths) {
      const stats = await fsPromises.stat(searchPath);
      if (stats.isDirectory()) {
        // Recursively find files in directory
        const files = await fg("**/*", {
          cwd: searchPath,
          absolute: true,
          onlyFiles: true,
          dot: false,
        });
        filesToSearch.push(...files);
      } else {
        filesToSearch.push(searchPath);
      }
    }

    // Search through files
    const matches: string[] = [];
    let outputLength = 0;
    let truncated = false;

    for (const filePath of filesToSearch) {
      try {
        const content = await fsPromises.readFile(filePath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineNumber = i + 1;

          // Check if line matches
          let isMatch = false;
          if (useRegex && pattern) {
            isMatch = pattern.test(line);
          } else {
            isMatch = line.includes(query);
          }

          if (isMatch) {
            const matchLine = `${filePath}:${lineNumber}: ${line}`;
            matches.push(matchLine);
            outputLength += matchLine.length + 1; // +1 for newline

            // Check if we've exceeded output limit
            if (outputLength > this.MAX_OUTPUT_LENGTH) {
              truncated = true;
              break;
            }
          }
        }

        if (truncated) break;
      } catch (error) {
        // Skip files that can't be read (binary files, permission errors, etc.)
        continue;
      }
    }

    if (matches.length === 0) {
      return `No matches found for query: ${query}`;
    }

    let result = matches.join("\n");
    if (truncated) {
      result += "\n\n[Output truncated - exceeded size limit]";
    }

    return result;
  }
}

/**
 * SearchFilesTool finds files matching a glob pattern.
 * Uses fast-glob for pattern matching.
 */
export class SearchFilesTool implements ExecutableTool {
  readonly name = "search_files";

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "search_files",
        description:
          "Finds files matching a glob pattern. Returns a list of matching file paths.",
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description:
                "Glob pattern to match files (e.g., 'src/**/*.ts', '**/*.md')",
            },
          },
          required: ["pattern"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = args.pattern as string;

    const files = await fg(pattern, {
      absolute: true,
      onlyFiles: true,
      dot: false,
    });

    if (files.length === 0) {
      return `No files found matching pattern: ${pattern}`;
    }

    return files.join("\n");
  }
}
