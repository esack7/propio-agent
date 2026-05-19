import { ExecutableTool } from "./interface.js";
import type { ToolDisplayAdapter } from "./displayAdapter.js";
import { ChatTool } from "../providers/types.js";
import {
  normalizeToolPath,
  throwToolPathAccessError,
  toStringArg,
  writeFileAtomically,
} from "./shared.js";

export class WriteTool implements ExecutableTool {
  readonly name = "write";
  readonly description = "Write a file atomically.";

  getDisplayAdapter(): ToolDisplayAdapter {
    return {
      renderUse(input) {
        const path = input.path;
        return typeof path === "string" && path.length > 0 ? path : null;
      },
      renderResult(result) {
        return result;
      },
    };
  }

  getInvocationLabel(args: Record<string, unknown>): string | undefined {
    const path = args.path;
    return typeof path === "string" && path.length > 0
      ? `Writing ${path}`
      : "Writing file";
  }

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "write",
        description:
          "Writes full content to a file, creating parent directories recursively and overwriting atomically.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file to write",
            },
            content: {
              type: "string",
              description: "Full file contents to write",
            },
          },
          required: ["path", "content"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawPath = args.path;
    const content = toStringArg(args.content, "content");
    const path = normalizeToolPath(rawPath);

    try {
      await writeFileAtomically(path, content);
      return `Wrote file: ${rawPath}`;
    } catch (error) {
      const err = error as NodeJS.ErrnoException | Error;
      throwToolPathAccessError(err, rawPath);
      throw new Error(`Failed to write file: ${err.message || String(error)}`);
    }
  }
}
