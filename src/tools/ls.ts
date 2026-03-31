import * as fsPromises from "fs/promises";
import { ExecutableTool } from "./interface.js";
import { ChatTool } from "../providers/types.js";
import { formatFileType, normalizeToolPath } from "./shared.js";

export class LsTool implements ExecutableTool {
  readonly name = "ls";

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "ls",
        description:
          "Lists a directory non-recursively with stable, human-readable entries that include type information.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Directory path to list",
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
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${rawPath}`);
      }

      const entries = await fsPromises.readdir(path, { withFileTypes: true });
      if (entries.length === 0) {
        return "Directory is empty";
      }

      const formatted = [...entries]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => formatFileType(entry, entry.name));

      return formatted.join("\n");
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
      if ("code" in err && err.code === "ENOTDIR") {
        throw new Error(`Path is not a directory: ${rawPath}`);
      }

      throw new Error(
        `Failed to list directory: ${err.message || String(error)}`,
      );
    }
  }
}
