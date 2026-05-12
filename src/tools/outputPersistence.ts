import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

interface PersistToolOutputParams {
  toolName: string;
  content: string;
  sessionsDir: string;
  sessionId: string;
  inlinePreviewBytes?: number;
}

interface PersistToolOutputResult {
  externalPath: string;
  externalSizeBytes: number;
  externalLineCount?: number;
  preview: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function countLines(content: string): number {
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") count++;
  }
  return count;
}

export function persistToolOutput(params: PersistToolOutputParams): PersistToolOutputResult {
  const { toolName, content, sessionsDir, sessionId, inlinePreviewBytes = 50 * 1024 } = params;
  const contentBytes = Buffer.byteLength(content, "utf8");

  // Create artifacts directory
  const artifactsDir = path.join(sessionsDir, "artifacts", sessionId);
  fs.mkdirSync(artifactsDir, { recursive: true });

  // Generate filename: {toolName}-{isoTimestamp}-{rand6}.txt
  const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5); // remove milliseconds and fractional seconds
  const rand = randomBytes(3).toString("hex");
  const filename = `${toolName}-${now}-${rand}.txt`;
  const externalPath = path.join(artifactsDir, filename);
  const tempPath = `${externalPath}.tmp`;

  // Atomic write
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, externalPath);

  // Calculate line count
  const lineCount = countLines(content);

  // Generate preview
  const previewContent = content.slice(0, inlinePreviewBytes);
  const previewHeader =
    `[output persisted: tool=${toolName} size=${formatBytes(contentBytes)} lines=${lineCount}\n` +
    ` path=${externalPath}\n` +
    ` To re-read: use the Read tool with startLine/lineCount or offset/limit params]\n`;
  const preview = previewHeader + previewContent;

  return {
    externalPath,
    externalSizeBytes: contentBytes,
    externalLineCount: lineCount,
    preview,
  };
}
