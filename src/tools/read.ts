import * as fsPromises from "fs/promises";
import { ExecutableTool } from "./interface.js";
import { ChatTool } from "../providers/types.js";
import { normalizeToolPath, readUtf8TextFile } from "./shared.js";

export interface ReadToolConfig {
  readonly outputInlineLimit?: number;
}

export class ReadTool implements ExecutableTool {
  readonly name = "read";
  readonly description = "Read a text file.";
  private readonly outputInlineLimit: number;

  constructor(config?: ReadToolConfig) {
    this.outputInlineLimit = config?.outputInlineLimit ?? 50 * 1024;
  }

  getInvocationLabel(args: Record<string, unknown>): string | undefined {
    const path = args.path;
    return typeof path === "string" && path.length > 0
      ? `Reading ${path}`
      : "Reading file";
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

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawPath = args.path;
    const path = normalizeToolPath(rawPath);
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

      // Line-based slicing
      if (startLine !== undefined || lineCount !== undefined) {
        if (startLine !== undefined && startLine < 1) {
          throw new Error(`startLine must be at least 1 (got ${startLine})`);
        }
        const lines = content.split("\n");
        const start = (startLine ?? 1) - 1;
        if (start >= lines.length) {
          throw new Error(
            `startLine ${startLine} is out of range (file has ${lines.length} lines)`,
          );
        }
        if (lineCount !== undefined && lineCount < 1) {
          throw new Error("lineCount must be at least 1");
        }
        if (lineCount !== undefined && lineCount > 5000) {
          throw new Error(`lineCount ${lineCount} exceeds maximum of 5000`);
        }
        const count = lineCount ?? lines.length - start;
        return lines.slice(start, start + count).join("\n");
      }

      // Byte-based slicing
      if (offset !== undefined || limit !== undefined) {
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

      // No slicing: return full content
      return content;
    } catch (error) {
      const err = error as NodeJS.ErrnoException | Error;

      if (err instanceof Error && err.message.startsWith("Path is")) {
        throw err;
      }
      if (err instanceof Error && err.message.includes("is out of range")) {
        throw err;
      }
      if (err instanceof Error && err.message.includes("must be")) {
        throw err;
      }
      if (err instanceof Error && err.message.includes("exceeds maximum")) {
        throw err;
      }
      if ("code" in err && err.code === "ENOENT") {
        const isArtifact =
          typeof path === "string" && path.includes("/artifacts/");
        const msg = isArtifact
          ? `Artifact file no longer available: ${rawPath}`
          : `File not found: ${rawPath}`;
        throw new Error(msg);
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
