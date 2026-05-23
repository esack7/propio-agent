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

type TextTranscriptEntry = Extract<TranscriptEntry, { text: string }>;
type TextTranscriptKind = TextTranscriptEntry["kind"];

const TEXT_TRANSCRIPT_RENDERERS: Record<
  TextTranscriptKind,
  (transcript: TranscriptRenderer, text: string) => void
> = {
  user_message: (transcript, text) => transcript.userMessage(text),
  assistant_token: (transcript, text) => transcript.writeAssistant(text),
  thinking_token: (transcript, text) => transcript.writeThinking(text),
  info: (transcript, text) => transcript.info(text),
  command: (transcript, text) => transcript.command(text),
  subtle: (transcript, text) => transcript.subtle(text),
  warn: (transcript, text) => transcript.warn(text),
  success: (transcript, text) => transcript.success(text),
  error: (transcript, text) => transcript.error(text),
  section: (transcript, text) => transcript.section(text),
  indent: (transcript, text) => transcript.indent(text),
  bash_command: (transcript, text) => transcript.bashCommand(text),
  bash_stdout: (transcript, text) => transcript.bashStdout(text),
  bash_stderr: (transcript, text) => transcript.bashStderr(text),
};

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

function isTextTranscriptEntry(
  entry: TranscriptEntry,
): entry is TextTranscriptEntry {
  return entry.kind in TEXT_TRANSCRIPT_RENDERERS;
}

export function renderTranscriptEntry(
  transcript: TranscriptRenderer,
  entry: TranscriptEntry,
): void {
  if (isTextTranscriptEntry(entry)) {
    TEXT_TRANSCRIPT_RENDERERS[entry.kind](transcript, entry.text);
    return;
  }

  switch (entry.kind) {
    case "assistant_start":
      transcript.beginAssistantResponse();
      break;
    case "thinking_start":
      transcript.beginThinkingResponse();
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
