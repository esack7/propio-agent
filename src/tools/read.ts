import type { ToolMetadata } from "../policy/capabilities.js";
import type { PathToolOptions } from "./localOptions.js";
import type { ToolExecutionContext } from "./execution.js";
import * as fsPromises from "fs/promises";
import { PresentedTool } from "./interface.js";
import {
  displayTitle,
  withFailure,
  type FileReadDisplay,
  type ToolDisplay,
} from "./display.js";
import type { ToolExecutionResult } from "./types.js";
import { ChatTool } from "@propio-ai/providers";
import {
  normalizeToolPath,
  throwFileOperationError,
  readUtf8TextFile,
  throwToolPathAccessError,
} from "./shared.js";

export interface ReadToolConfig extends PathToolOptions {
  readonly outputInlineLimit?: number;
}

function throwReadFileSystemError(
  err: NodeJS.ErrnoException | Error,
  rawPath: unknown,
  path: string,
): void {
  if (!("code" in err)) {
    return;
  }

  if (err.code === "ENOENT") {
    const isArtifact = typeof path === "string" && path.includes("/artifacts/");
    throw new Error(
      isArtifact
        ? `Artifact file no longer available: ${rawPath}`
        : `File not found: ${rawPath}`,
    );
  }

  throwToolPathAccessError(err, rawPath);
}

export class ReadTool implements PresentedTool {
  readonly name = "read";
  readonly metadata: ToolMetadata = {
    capabilities: ["read"],
    readOnly: true,
    concurrencySafe: true,
  };
  readonly description = "Read a text file.";
  private readonly outputInlineLimit: number;

  private readonly resolvePath: (rawPath: unknown) => string;

  constructor(config?: ReadToolConfig) {
    this.resolvePath = config?.resolvePath ?? normalizeToolPath;
    this.outputInlineLimit = config?.outputInlineLimit ?? 50 * 1024;
  }

  describeCall(
    args: Readonly<Record<string, unknown>>,
  ): ToolDisplay<FileReadDisplay> {
    const path = typeof args.path === "string" ? args.path : "";
    const start = typeof args.startLine === "number" ? args.startLine : 1;
    const count =
      typeof args.lineCount === "number" ? args.lineCount : undefined;
    const ranged = args.startLine !== undefined || count !== undefined;
    return {
      title: displayTitle(path ? `Reading ${path}` : "Reading file"),
      body: {
        kind: "file_read",
        path,
        ...(ranged
          ? { range: { start, ...(count === undefined ? {} : { count }) } }
          : {}),
      },
    };
  }

  describeResult(
    args: Readonly<Record<string, unknown>>,
    result: Readonly<ToolExecutionResult>,
  ): ToolDisplay {
    const call = this.describeCall(args);
    if (result.status !== "success") return withFailure(call, result.content);
    return {
      ...call,
      body: { ...call.body, lines: result.content.split("\n").length },
    };
  }

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "read",
        description:
          "Reads a single text file and returns its contents. Rejects directories and unreadable files. For large files (persisted by agent layer), use startLine/lineCount or offset/limit to read specific ranges.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file to read",
            },
            startLine: {
              type: "integer",
              description:
                "1-based line number to start reading from (for line-based slicing)",
            },
            lineCount: {
              type: "integer",
              description:
                "Number of lines to read (max 5000; for line-based slicing)",
            },
            offset: {
              type: "integer",
              description:
                "Byte offset to start reading from (for binary or large files)",
            },
            limit: {
              type: "integer",
              description: "Maximum bytes to read (for binary or large files)",
            },
          },
          required: ["path"],
        },
      },
    };
  }

  private validateLineRange(
    startLine: number | undefined,
    lineCount: number | undefined,
    totalLines: number,
  ): void {
    if (startLine !== undefined && startLine < 1) {
      throw new Error(`startLine must be at least 1 (got ${startLine})`);
    }

    const start = (startLine ?? 1) - 1;
    if (start >= totalLines) {
      throw new Error(
        `startLine ${startLine} is out of range (file has ${totalLines} lines)`,
      );
    }

    if (lineCount !== undefined && lineCount < 1) {
      throw new Error("lineCount must be at least 1");
    }

    if (lineCount !== undefined && lineCount > 5000) {
      throw new Error(`lineCount ${lineCount} exceeds maximum of 5000`);
    }
  }

  private sliceByLines(
    content: string,
    startLine: number | undefined,
    lineCount: number | undefined,
  ): string {
    const lines = content.split("\n");
    this.validateLineRange(startLine, lineCount, lines.length);
    const start = (startLine ?? 1) - 1;
    const count = lineCount ?? lines.length - start;
    return lines.slice(start, start + count).join("\n");
  }

  private sliceByBytes(
    content: string,
    offset: number | undefined,
    limit: number | undefined,
  ): string {
    const buf = Buffer.from(content, "utf8");
    const offsetVal = offset ?? 0;
    if (offsetVal < 0) {
      throw new Error("offset must be non-negative");
    }
    if (limit !== undefined && limit < 1) {
      throw new Error("limit must be at least 1");
    }
    const cappedLimit = Math.min(
      limit ?? buf.length - offsetVal,
      this.outputInlineLimit,
    );
    const end = Math.min(offsetVal + cappedLimit, buf.length);
    return buf.slice(offsetVal, end).toString("utf8");
  }

  private rethrowKnownReadMessageErrors(err: Error): void {
    if (err.message.startsWith("Path is")) throw err;
    if (err.message.includes("is out of range")) throw err;
    if (err.message.includes("must be")) throw err;
    if (err.message.includes("exceeds maximum")) throw err;
  }

  private classifyReadError(
    error: unknown,
    rawPath: unknown,
    path: string,
  ): never {
    const err = error as NodeJS.ErrnoException | Error;
    if (err instanceof Error) {
      this.rethrowKnownReadMessageErrors(err);
    }
    throwReadFileSystemError(err, rawPath, path);
    throwFileOperationError(error, "read");
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<string> {
    context.signal?.throwIfAborted();
    const rawPath = args.path;
    const path = this.resolvePath(rawPath);
    const startLine = args.startLine as number | undefined;
    const lineCount = args.lineCount as number | undefined;
    const offset = args.offset as number | undefined;
    const limit = args.limit as number | undefined;

    try {
      const stats = await fsPromises.stat(path);
      if (stats.isDirectory()) {
        throw new Error(`Path is a directory, not a file: ${rawPath}`);
      }

      const content = await readUtf8TextFile(path);

      if (startLine !== undefined || lineCount !== undefined) {
        return this.sliceByLines(content, startLine, lineCount);
      }

      if (offset !== undefined || limit !== undefined) {
        return this.sliceByBytes(content, offset, limit);
      }

      return content;
    } catch (error) {
      this.classifyReadError(error, rawPath, path);
    }
  }
}
