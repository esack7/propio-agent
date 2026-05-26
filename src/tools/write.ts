import { ExecutableTool } from "./interface.js";
import type { ToolDisplayAdapter } from "./displayAdapter.js";
import { ChatTool } from "../providers/types.js";
import {
  createPathToolDisplayAdapter,
  getPathToolInvocationLabel,
  normalizeToolPath,
  throwToolPathAccessError,
  toStringArg,
  writeFileAtomically,
} from "./shared.js";

export class WriteTool implements ExecutableTool {
  readonly name = "write";
  readonly description = "Write a file atomically.";

  getDisplayAdapter(): ToolDisplayAdapter {
    return createPathToolDisplayAdapter();
  }

  getInvocationLabel(args: Record<string, unknown>): string | undefined {
    return getPathToolInvocationLabel(args, "Writing", "Writing file");
  }

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "write",
        description:
          "Writes full content to a file, creating parent directories recursively and overwriting atomically. Prefer the scratchpad directory from # Scratchpad Directory for temporary or non-deliverable files (intermediate data, one-off scripts, temp outputs). Only create new files in the workspace when the user asked for a durable change or deliverable.",
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
