import type { PathToolOptions } from "./localOptions.js";
import type { ToolExecutionContext } from "./execution.js";
import type { ToolExecutionResult } from "./types.js";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { PresentedTool } from "./interface.js";
import { ChatTool } from "@propio-ai/providers";
import {
  createPathToolDisplayAdapter,
  getPathToolInvocationLabel,
  normalizeToolPath,
  throwToolPathAccessError,
  toStringArg,
  writeFileAtomically,
} from "./shared.js";

export class WriteTool implements PresentedTool {
  readonly name = "write";
  readonly description = "Write a file atomically.";

  constructor(private readonly options: PathToolOptions = {}) {}

  getDisplayAdapter() {
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

  async executeWithStatus(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolExecutionResult> {
    context.signal?.throwIfAborted();
    const rawPath = args.path;
    const content = toStringArg(args.content, "content");
    const path = (this.options.resolvePath ?? normalizeToolPath)(rawPath);

    try {
      const before = await fsPromises.readFile(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      });
      context.signal?.throwIfAborted();
      await writeFileAtomically(path, content);
      return {
        status: "success",
        content: `Wrote file: ${rawPath}`,
        outcome: {
          kind: "file_write",
          classification: "succeeded",
          resolvedPath: path,
          operation: before === undefined ? "create" : "replace",
          beforeHash:
            before === undefined ? undefined : createContentHash(before),
          afterHash: createContentHash(content),
          sideEffect: "completed",
        },
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException | Error;
      throwToolPathAccessError(err, rawPath);
      throw new Error(`Failed to write file: ${err.message || String(error)}`);
    }
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    return (await this.executeWithStatus(args, context)).content;
  }
}

function createContentHash(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
