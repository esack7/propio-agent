import * as fsPromises from "fs/promises";
import { ExecutableTool } from "./interface.js";
import { ChatTool } from "../providers/types.js";
import { normalizeToolPath, readUtf8TextFile, truncateText } from "./shared.js";

const READ_OUTPUT_LIMIT = 50 * 1024;

export class ReadTool implements ExecutableTool {
  readonly name = "read";

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "read",
        description:
          "Reads a single text file and returns its contents. Rejects directories and unreadable files. Output is truncated with an explicit marker when it exceeds the tool limit.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file to read",
            },
          },
          required: ["path"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawPath = args.path;
    const path = normalizeToolPath(rawPath);

    try {
      const stats = await fsPromises.stat(path);
      if (stats.isDirectory()) {
        throw new Error(`Path is a directory, not a file: ${rawPath}`);
      }

      const content = await readUtf8TextFile(path);
      const truncated = truncateText(content, READ_OUTPUT_LIMIT);

      return truncated.truncated ? truncated.value : content;
    } catch (error) {
      const err = error as NodeJS.ErrnoException | Error;

      if (err instanceof Error && err.message.startsWith("Path is")) {
        throw err;
      }
      if ("code" in err && err.code === "ENOENT") {
        throw new Error(`File not found: ${rawPath}`);
      }
      if ("code" in err && (err.code === "EACCES" || err.code === "EPERM")) {
        throw new Error(`Permission denied: ${rawPath}`);
      }
      if ("code" in err && err.code === "EISDIR") {
        throw new Error(`Path is a directory, not a file: ${rawPath}`);
      }

      throw new Error(`Failed to read file: ${err.message || String(error)}`);
    }
  }
}
