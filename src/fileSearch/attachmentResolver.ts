import * as fsPromises from "fs/promises";
import * as path from "path";
import { ChatToolCall } from "../providers/types.js";
import { ArtifactToolResult } from "../context/types.js";
import {
  formatFileType,
  readUtf8TextFile,
  truncateText,
} from "../tools/shared.js";
import { MentionParser, type ParsedFileMention } from "./mentionParser.js";

export interface MentionAttachment {
  readonly toolCall: ChatToolCall;
  readonly toolResult: ArtifactToolResult;
  readonly mention: ParsedFileMention;
}

const CONTROL_CHARACTERS = /[\x00-\x1f]/;
const MAX_DIRECTORY_ENTRIES = 1000;
const READ_OUTPUT_LIMIT = 50 * 1024;

function normalizeMentionPath(
  rawPath: string,
  cwd: string,
  homeDir: string,
): string {
  if (rawPath.length === 0) {
    throw new Error("path must be a non-empty string");
  }

  if (CONTROL_CHARACTERS.test(rawPath)) {
    throw new Error("Invalid path: contains control characters");
  }

  if (rawPath === "~") {
    return homeDir;
  }

  if (rawPath.startsWith("~/")) {
    return path.resolve(homeDir, rawPath.slice(2));
  }

  const normalized = path.normalize(rawPath);
  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(cwd, normalized);
}

function lineRangeLabel(mention: ParsedFileMention): string | undefined {
  if (!mention.range) {
    return undefined;
  }

  if (mention.range.endLine !== undefined) {
    return `${mention.path}#L${mention.range.startLine}-${mention.range.endLine}`;
  }

  return `${mention.path}#L${mention.range.startLine}`;
}

function selectLineRange(content: string, mention: ParsedFileMention): string {
  if (!mention.range) {
    return content;
  }

  const lines = content.split(/\r\n|\r|\n/);
  const startIndex = mention.range.startLine - 1;
  const endIndex = Math.min(
    lines.length,
    mention.range.endLine ?? mention.range.startLine,
  );

  if (startIndex >= lines.length) {
    return "";
  }

  return lines.slice(startIndex, endIndex).join("\n");
}

function buildToolCall(
  toolCallId: string,
  toolName: "read" | "ls",
  mention: ParsedFileMention,
  resolvedPath: string,
): ChatToolCall {
  return {
    id: toolCallId,
    function: {
      name: toolName,
      arguments: {
        path: mention.path,
        resolvedPath,
        ...(mention.range
          ? {
              startLine: mention.range.startLine,
              ...(mention.range.endLine !== undefined
                ? { endLine: mention.range.endLine }
                : {}),
            }
          : {}),
      },
    },
  };
}

function successResult(
  toolCallId: string,
  toolName: "read" | "ls",
  content: string,
): ArtifactToolResult {
  return {
    toolCallId,
    toolName,
    rawContent: content,
    status: "success",
  };
}

function errorResult(
  toolCallId: string,
  toolName: "read" | "ls",
  message: string,
): ArtifactToolResult {
  return {
    toolCallId,
    toolName,
    rawContent: `Error: ${message}`,
    status: "error",
  };
}

export class AttachmentResolver {
  private readonly parser = new MentionParser();

  constructor(
    private readonly options: {
      readonly cwd: string;
      readonly homeDir: string;
    },
  ) {}

  async resolveText(text: string): Promise<MentionAttachment[]> {
    return await this.resolveMentions(this.parser.parse(text));
  }

  async resolveMentions(
    mentions: readonly ParsedFileMention[],
  ): Promise<MentionAttachment[]> {
    const attachments: MentionAttachment[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < mentions.length; index += 1) {
      const mention = mentions[index];
      const dedupeKey = [
        mention.path,
        mention.range
          ? `${mention.range.startLine}:${mention.range.endLine ?? ""}`
          : "",
      ].join("|");

      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      const toolCallId = `mention_${index + 1}`;
      let resolvedPath = mention.path;

      try {
        resolvedPath = normalizeMentionPath(
          mention.path,
          this.options.cwd,
          this.options.homeDir,
        );
        const stats = await fsPromises.stat(resolvedPath);

        if (stats.isDirectory()) {
          const entries = await fsPromises.readdir(resolvedPath, {
            withFileTypes: true,
          });
          const formatted = entries
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, MAX_DIRECTORY_ENTRIES)
            .map((entry) => formatFileType(entry, entry.name));
          const omitted = entries.length - formatted.length;
          const content =
            formatted.length === 0
              ? "Directory is empty"
              : omitted > 0
                ? `${formatted.join("\n")}\n[output truncated: ${omitted} entries omitted]`
                : formatted.join("\n");

          attachments.push({
            mention,
            toolCall: buildToolCall(toolCallId, "ls", mention, resolvedPath),
            toolResult: successResult(toolCallId, "ls", content),
          });
          continue;
        }

        const fileContent = await readUtf8TextFile(resolvedPath);
        const selectedContent = selectLineRange(fileContent, mention);
        const normalizedContent = truncateText(
          mention.range
            ? `${lineRangeLabel(mention)}\n${selectedContent}`
            : selectedContent,
          READ_OUTPUT_LIMIT,
        ).value;

        attachments.push({
          mention,
          toolCall: buildToolCall(toolCallId, "read", mention, resolvedPath),
          toolResult: successResult(toolCallId, "read", normalizedContent),
        });
      } catch (error) {
        const err = error as NodeJS.ErrnoException | Error;
        let message = err instanceof Error ? err.message : String(error);

        if ("code" in err && err.code === "ENOENT") {
          message = `File not found: ${mention.path}`;
        } else if (
          "code" in err &&
          (err.code === "EACCES" || err.code === "EPERM")
        ) {
          message = `Permission denied: ${mention.path}`;
        } else if ("code" in err && err.code === "EISDIR") {
          message = `Path is a directory, not a file: ${mention.path}`;
        } else if (message.length === 0) {
          message = `Failed to resolve mention: ${mention.raw}`;
        }

        attachments.push({
          mention,
          toolCall: buildToolCall(toolCallId, "read", mention, resolvedPath),
          toolResult: errorResult(toolCallId, "read", message),
        });
      }
    }

    return attachments;
  }
}
