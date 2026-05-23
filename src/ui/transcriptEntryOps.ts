import type { TranscriptRenderer } from "./transcriptRenderer.js";
import type { TerminalWriter } from "./terminalWriter.js";
import type { TranscriptEntry } from "./replUi.js";

const TEXT_TRANSCRIPT_KINDS = new Set<TranscriptEntry["kind"]>([
  "user_message",
  "info",
  "command",
  "subtle",
  "warn",
  "success",
  "error",
  "section",
  "indent",
  "assistant_token",
  "thinking_token",
  "bash_command",
  "bash_stdout",
  "bash_stderr",
]);

function formatDurationSeconds(durationMs: number): string {
  return `${(Math.max(0, durationMs) / 1000).toFixed(1)}s`;
}

export function transcriptEntriesEqual(
  left: TranscriptEntry,
  right: TranscriptEntry,
): boolean {
  if (left === right) {
    return true;
  }

  if (left.kind !== right.kind) {
    return false;
  }

  if (
    TEXT_TRANSCRIPT_KINDS.has(left.kind) &&
    TEXT_TRANSCRIPT_KINDS.has(right.kind)
  ) {
    return (
      left.kind === right.kind &&
      (left as Extract<TranscriptEntry, { text: string }>).text ===
        (right as Extract<TranscriptEntry, { text: string }>).text
    );
  }

  if (left.kind === "assistant_start" || left.kind === "thinking_start") {
    return true;
  }

  if (left.kind === "reasoning_summary") {
    return (
      right.kind === "reasoning_summary" &&
      left.summary === right.summary &&
      left.source === right.source
    );
  }

  if (left.kind === "turn_complete" || left.kind === "turn_failed") {
    return left.durationMs === (right as typeof left).durationMs;
  }

  return (
    left.kind === "json" && left.value === (right as { value: unknown }).value
  );
}

export function renderTranscriptEntry(
  transcript: TranscriptRenderer,
  entry: TranscriptEntry,
): void {
  switch (entry.kind) {
    case "user_message":
      transcript.userMessage(entry.text);
      break;
    case "assistant_start":
      transcript.beginAssistantResponse();
      break;
    case "assistant_token":
      transcript.writeAssistant(entry.text);
      break;
    case "thinking_start":
      transcript.beginThinkingResponse();
      break;
    case "thinking_token":
      transcript.writeThinking(entry.text);
      break;
    case "info":
      transcript.info(entry.text);
      break;
    case "command":
      transcript.command(entry.text);
      break;
    case "subtle":
      transcript.subtle(entry.text);
      break;
    case "warn":
      transcript.warn(entry.text);
      break;
    case "success":
      transcript.success(entry.text);
      break;
    case "error":
      transcript.error(entry.text);
      break;
    case "section":
      transcript.section(entry.text);
      break;
    case "indent":
      transcript.indent(entry.text);
      break;
    case "reasoning_summary":
      transcript.reasoningSummary(entry.summary, entry.source);
      break;
    case "turn_complete":
      transcript.turnComplete(entry.durationMs);
      break;
    case "turn_failed":
      transcript.turnFailed(entry.durationMs);
      break;
    case "bash_command":
      transcript.bashCommand(entry.text);
      break;
    case "bash_stdout":
      transcript.bashStdout(entry.text);
      break;
    case "bash_stderr":
      transcript.bashStderr(entry.text);
      break;
    case "json":
      transcript.writeJson(entry.value);
      break;
  }
}

export function countTranscriptEntryStderrLines(
  entry: TranscriptEntry,
  writer: TerminalWriter,
  countLine: (text: string, writer: TerminalWriter) => number,
): number {
  switch (entry.kind) {
    case "section":
      return countLine("", writer) + countLine(entry.text, writer);
    case "reasoning_summary":
      return (
        countLine("", writer) +
        countLine(
          `Reasoning summary (${entry.source}): ${entry.summary}`,
          writer,
        )
      );
    case "assistant_start":
      return countLine("", writer) + 1;
    case "assistant_token":
    case "info":
    case "command":
    case "subtle":
    case "warn":
    case "success":
    case "error":
    case "bash_command":
    case "bash_stdout":
    case "bash_stderr":
      return countLine(entry.text, writer);
    case "indent":
      return countLine(`  ${entry.text}`, writer);
    case "turn_complete":
      return countLine(
        `Turn complete in ${formatDurationSeconds(entry.durationMs)}`,
        writer,
      );
    case "turn_failed":
      return countLine(
        `Turn failed in ${formatDurationSeconds(entry.durationMs)}`,
        writer,
      );
    case "json":
      return countLine(JSON.stringify(entry.value, null, 2), writer);
    default:
      return 0;
  }
}
