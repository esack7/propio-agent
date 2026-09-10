import type { PathToolOptions } from "./localOptions.js";
import type { ToolExecutionContext } from "./execution.js";
import * as fsPromises from "fs/promises";
import { PresentedTool } from "./interface.js";
import type { ToolDisplayAdapter } from "./displayAdapter.js";
import { ChatTool } from "@propio-ai/providers";
import {
  formatFileType,
  normalizeToolPath,
  throwDirectoryOperationError,
} from "./shared.js";

export class LsTool implements PresentedTool {
  readonly name = "ls";
  readonly description = "List directory contents.";

  private readonly resolvePath: (rawPath: unknown) => string;

  constructor(options?: PathToolOptions) {
    this.resolvePath = options?.resolvePath ?? normalizeToolPath;
  }

  getDisplayAdapter(): ToolDisplayAdapter {
    return {
      renderUse(input) {
        const path = input.path;
        return typeof path === "string" && path.length > 0 ? path : null;
      },
      renderResult(result) {
        if (result === "Directory is empty") {
          return "Empty directory";
        }
        const lines = result
          .trim()
          .split("\n")
          .filter((l) => l.length > 0);
        return `${lines.length} item${lines.length === 1 ? "" : "s"}`;
      },
    };
  }

  getInvocationLabel(args: Record<string, unknown>): string | undefined {
    const path = args.path;
    return typeof path === "string" && path.length > 0
      ? `Listing ${path}`
      : "Listing directory";
  }

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

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<string> {
    context.signal?.throwIfAborted();
    const rawPath = args.path;
    const path = this.resolvePath(rawPath);

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
      throwDirectoryOperationError(error, rawPath, "list directory", true);
    }
  }
}
