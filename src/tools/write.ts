import type { ToolMetadata } from "../policy/capabilities.js";
import type { PathToolOptions } from "./localOptions.js";
import type { ToolExecutionContext } from "./execution.js";
import type { ToolExecutionResult } from "./types.js";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { PresentedTool, type ToolDescribeContext } from "./interface.js";
import type { ToolDisplay } from "./display.js";
import {
  createContentHash,
  finishFileChange,
  previewFileChange,
} from "./fileChangeDisplay.js";
import { ChatTool } from "@propio-ai/providers";
import {
  getPathToolInvocationLabel,
  normalizeToolPath,
  throwToolPathAccessError,
  toStringArg,
  writeFileAtomically,
} from "./shared.js";

export class WriteTool implements PresentedTool {
  readonly name = "write";
  readonly metadata: ToolMetadata = {
    capabilities: ["workspace_write"],
    readOnly: false,
    concurrencySafe: false,
  };
  readonly description = "Write a file atomically.";

  constructor(private readonly options: PathToolOptions = {}) {}

  describeCall(
    args: Readonly<Record<string, unknown>>,
    context?: ToolDescribeContext,
  ): Promise<ToolDisplay> {
    return previewFileChange({
      title: getPathToolInvocationLabel(args, "Writing", "Writing file"),
      rawPath: args.path,
      resolvePath: this.options.resolvePath ?? normalizeToolPath,
      context,
      next: () => toStringArg(args.content, "content"),
    });
  }

  describeResult(
    args: Readonly<Record<string, unknown>>,
    result: Readonly<ToolExecutionResult>,
    before: ToolDisplay,
  ): ToolDisplay {
    return finishFileChange(
      getPathToolInvocationLabel(args, "Writing", "Writing file"),
      args.path,
      result,
      before,
    );
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
      const existed = await fileExists(path);
      const beforeHash = existed ? await hashFileContents(path) : undefined;
      context.signal?.throwIfAborted();
      await writeFileAtomically(path, content);
      return {
        status: "success",
        content: `Wrote file: ${rawPath}`,
        outcome: {
          kind: "file_write",
          classification: "succeeded",
          resolvedPath: path,
          operation: existed ? "replace" : "create",
          beforeHash,
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await fsPromises.stat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function hashFileContents(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  try {
    handle = await fsPromises.open(path, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}
