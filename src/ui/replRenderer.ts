import { FooterRenderer } from "./footerRenderer.js";
import { StatusRenderer } from "./statusRenderer.js";
import { TranscriptRenderer } from "./transcriptRenderer.js";
import type { TerminalWriter } from "./terminalWriter.js";
import { visibleLength, wrapTextToWidth } from "./terminalWriter.js";
import * as readline from "readline";
import type {
  EphemeralStatus,
  OverlayState,
  ToolActivityState,
  ReplUiState,
  TranscriptEntry,
} from "./replUi.js";

export interface ReplRendererOptions {
  writer: TerminalWriter;
  transcriptRenderer: TranscriptRenderer;
  statusRenderer: StatusRenderer;
  footerRenderer: FooterRenderer;
}

function statusKey(status: EphemeralStatus | null): string {
  return status ? JSON.stringify(status) : "null";
}

function overlayKey(overlay: OverlayState | null): string {
  return overlay ? JSON.stringify(overlay) : "null";
}

function promptKey(prompt: ReplUiState["prompt"]): string {
  return prompt ? JSON.stringify(prompt) : "null";
}

function activityKey(activity: ToolActivityState | null): string {
  return activity ? JSON.stringify(activity) : "null";
}

export class ReplRenderer {
  private previousState: ReplUiState | null = null;
  private renderedBottomLineCount = 0;

  constructor(private readonly options: ReplRendererOptions) {}

  flush(nextState: ReplUiState): void {
    const previousState = this.previousState;

    if (previousState?.status && !nextState.status) {
      this.options.statusRenderer.clear();
    }

    if (
      statusKey(previousState?.status ?? null) !== statusKey(nextState.status)
    ) {
      this.renderStatus(nextState.status);
    }

    const previousTranscriptLength = previousState?.transcript.length ?? 0;
    const transcriptAppended =
      nextState.transcript.length > previousTranscriptLength;
    const bottomSignatureChanged =
      promptKey(previousState?.prompt ?? null) !==
        promptKey(nextState.prompt) ||
      activityKey(previousState?.activity ?? null) !==
        activityKey(nextState.activity) ||
      previousState?.footer !== nextState.footer ||
      overlayKey(previousState?.overlay ?? null) !==
        overlayKey(nextState.overlay);
    const shouldClearBottomZone =
      this.renderedBottomLineCount > 0 &&
      (bottomSignatureChanged || transcriptAppended);

    if (shouldClearBottomZone) {
      this.options.writer.clearStderrLines(this.renderedBottomLineCount);
      this.renderedBottomLineCount = 0;
    }

    for (const entry of nextState.transcript.slice(previousTranscriptLength)) {
      this.renderTranscriptEntry(entry);
    }

    if (bottomSignatureChanged || transcriptAppended) {
      this.renderedBottomLineCount = this.renderBottomZone(nextState);
    }

    this.previousState = nextState;
  }

  private renderStatus(status: EphemeralStatus | null): void {
    if (!status) {
      return;
    }

    switch (status.kind) {
      case "status":
        this.options.statusRenderer.status(status.text, status.phase);
        break;
      case "progress":
        this.options.statusRenderer.progress(
          status.current,
          status.total,
          status.label,
        );
        break;
    }
  }

  private renderTranscriptEntry(entry: TranscriptEntry): void {
    switch (entry.kind) {
      case "user_message":
        this.options.transcriptRenderer.userMessage(entry.text);
        break;
      case "assistant_start":
        this.options.transcriptRenderer.beginAssistantResponse();
        break;
      case "assistant_token":
        this.options.transcriptRenderer.writeAssistant(entry.text);
        break;
      case "info":
        this.options.transcriptRenderer.info(entry.text);
        break;
      case "command":
        this.options.transcriptRenderer.command(entry.text);
        break;
      case "subtle":
        this.options.transcriptRenderer.subtle(entry.text);
        break;
      case "warn":
        this.options.transcriptRenderer.warn(entry.text);
        break;
      case "success":
        this.options.transcriptRenderer.success(entry.text);
        break;
      case "error":
        this.options.transcriptRenderer.error(entry.text);
        break;
      case "section":
        this.options.transcriptRenderer.section(entry.text);
        break;
      case "indent":
        this.options.transcriptRenderer.indent(entry.text);
        break;
      case "reasoning_summary":
        this.options.transcriptRenderer.reasoningSummary(
          entry.summary,
          entry.source,
        );
        break;
      case "turn_complete":
        this.options.transcriptRenderer.turnComplete(entry.durationMs);
        break;
      case "json":
        this.options.transcriptRenderer.writeJson(entry.value);
        break;
    }
  }

  private renderOverlay(overlay: OverlayState | null): void {
    if (!overlay) {
      return;
    }

    for (const entry of overlay.entries) {
      this.renderTranscriptEntry(entry);
    }
  }

  private renderBottomZone(state: ReplUiState): number {
    let renderedLines = 0;

    if (state.activity) {
      this.options.writer.writeStderrLine(`Activity: ${state.activity.text}`);
      renderedLines += 1;
    }

    if (state.overlay) {
      this.renderOverlay(state.overlay);
      renderedLines += countOverlayLines(state.overlay, this.options.writer);
    }

    if (state.footer && state.prompt) {
      this.options.footerRenderer.idleFooter(state.footer);
      renderedLines += 1;
    }

    if (state.prompt) {
      const promptLines = formatPromptSnapshot(state.prompt);
      let cursorPlacement: PromptCursorPlacement | null = null;

      for (const line of promptLines) {
        for (const wrappedLine of this.options.writer
          .fitToTerminalWidth(line)
          .split("\n")) {
          this.options.writer.writeStderrLine(wrappedLine);
        }
      }

      renderedLines += promptLines.reduce(
        (total, line) =>
          total +
          this.options.writer.fitToTerminalWidth(line).split("\n").length,
        0,
      );

      cursorPlacement = computePromptCursorPlacement(
        state.prompt,
        this.options.writer,
      );
      if (cursorPlacement) {
        const stderrStream = this.options.writer.getStderrStream();
        readline.moveCursor(stderrStream, 0, -cursorPlacement.linesUp);
        readline.cursorTo(stderrStream, cursorPlacement.column);
      }
    }

    return renderedLines;
  }
}

function countOverlayLines(
  overlay: OverlayState,
  writer: TerminalWriter,
): number {
  let count = 0;

  for (const entry of overlay.entries) {
    switch (entry.kind) {
      case "section":
        count += countWrittenStderrLines("", writer);
        count += countWrittenStderrLines(entry.text, writer);
        break;
      case "reasoning_summary":
        count += countWrittenStderrLines("", writer);
        count += countWrittenStderrLines(
          `Reasoning summary (${entry.source}): ${entry.summary}`,
          writer,
        );
        break;
      case "assistant_start":
        count += countWrittenStderrLines("", writer) + 1;
        break;
      case "assistant_token":
        count += countWrittenStderrLines(entry.text, writer);
        break;
      case "info":
      case "command":
      case "subtle":
      case "warn":
      case "success":
      case "error":
        count += countWrittenStderrLines(entry.text, writer);
        break;
      case "indent":
        count += countWrittenStderrLines(`  ${entry.text}`, writer);
        break;
      case "turn_complete":
        count += countWrittenStderrLines(
          `Turn complete in ${(Math.max(0, entry.durationMs) / 1000).toFixed(1)}s`,
          writer,
        );
        break;
      case "json":
        count += 0;
        break;
    }
  }

  return count;
}

function countLines(text: string): number {
  return Math.max(1, text.split("\n").length);
}

const ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCharacter(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function getDisplayWidth(text: string): number {
  let width = 0;
  for (const character of stripAnsi(text)) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }

    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      continue;
    }

    if (isCombiningMark(codePoint)) {
      continue;
    }

    width += isWideCharacter(codePoint) ? 2 : 1;
  }

  return width;
}

function countWrittenStderrLines(text: string, writer: TerminalWriter): number {
  const fitted = writer.fitToTerminalWidth(
    text.endsWith("\n") ? text : `${text}\n`,
  );
  const trimmed = fitted.endsWith("\n") ? fitted.slice(0, -1) : fitted;
  return Math.max(1, trimmed.split("\n").length);
}

interface PromptCursorPlacement {
  linesUp: number;
  column: number;
}

function computePromptCursorPlacement(
  prompt: NonNullable<ReplUiState["prompt"]>,
  writer: TerminalWriter,
): PromptCursorPlacement | null {
  const buffer = prompt.buffer ?? "";
  const promptText = prompt.promptText ?? "";
  const lines = buffer.split("\n");
  const promptPrefixWidth = visibleLength(promptText);
  const indent = " ".repeat(promptPrefixWidth);
  const lineWidths = lines.map((line, index) =>
    countWrappedDisplayLines(
      `${index === 0 ? promptText : indent}${line}`,
      writer,
    ),
  );

  const cursor = Math.max(0, Math.min(prompt.cursor, buffer.length));
  const beforeCursor = buffer.slice(0, cursor);
  const cursorLine = beforeCursor.split("\n").length - 1;
  const lastNewlineIndex = beforeCursor.lastIndexOf("\n");
  const lineTextBeforeCursor =
    lastNewlineIndex >= 0
      ? beforeCursor.slice(lastNewlineIndex + 1)
      : beforeCursor;
  const lineColumn = getDisplayWidth(lineTextBeforeCursor);
  const displayColumn = promptPrefixWidth + lineColumn;
  const maxWidth = getMaxWidth(writer);
  const wrappedLineOffset =
    maxWidth === null ? 0 : Math.floor(displayColumn / maxWidth);
  const wrappedColumn =
    maxWidth === null ? displayColumn : displayColumn % maxWidth;
  const rowsBeforeCursor =
    lineWidths.slice(0, cursorLine).reduce((total, value) => total + value, 0) +
    wrappedLineOffset;
  const statusLine = formatPromptStatusLine(prompt);
  const statusLines = statusLine
    ? countWrappedDisplayLines(statusLine, writer)
    : 0;
  const totalRenderedPromptRows =
    lineWidths.reduce((total, value) => total + value, 0) + statusLines;
  const linesUp = Math.max(0, totalRenderedPromptRows - rowsBeforeCursor);

  return { linesUp, column: wrappedColumn };
}

function countWrappedDisplayLines(
  text: string,
  writer: TerminalWriter,
): number {
  const maxWidth = getMaxWidth(writer);
  if (maxWidth === null) {
    return countLines(text);
  }

  return text
    .split("\n")
    .reduce((total, line) => total + wrapTextToWidth(line, maxWidth).length, 0);
}

function getMaxWidth(writer: TerminalWriter): number | null {
  const stderr = writer.getStderrStream();
  if (!stderr.isTTY || !stderr.columns || stderr.columns < 10) {
    return null;
  }

  return Math.max(1, stderr.columns - 1);
}

function formatPromptSnapshot(
  prompt: NonNullable<ReplUiState["prompt"]>,
): string[] {
  const promptText = prompt.promptText ?? "";
  const buffer = prompt.buffer;
  const lines = buffer.split("\n");
  const formatted: string[] = [];
  const indent = " ".repeat(visibleLength(promptText));

  for (let index = 0; index < lines.length; index += 1) {
    formatted.push(`${index === 0 ? promptText : indent}${lines[index]}`);
  }

  const statusLine = formatPromptStatusLine(prompt);
  if (statusLine) {
    formatted.push(statusLine);
  }

  return formatted;
}

function formatPromptStatusLine(
  prompt: NonNullable<ReplUiState["prompt"]>,
): string | null {
  if (prompt.editorStatus) {
    return prompt.editorStatus;
  }

  if (prompt.historySearch) {
    return prompt.historySearch.match
      ? `history search: ${prompt.historySearch.query}  match: ${prompt.historySearch.match}`
      : `history search: ${prompt.historySearch.query}  no matches`;
  }

  if (prompt.typeahead) {
    if (prompt.typeahead.matchCount === 0 || !prompt.typeahead.match) {
      return "tab: no matches";
    }

    if (prompt.typeahead.matchCount === 1) {
      return `tab: ${prompt.typeahead.match}`;
    }

    return `tab: ${prompt.typeahead.match} (${prompt.typeahead.matchIndex + 1}/${prompt.typeahead.matchCount})`;
  }

  if (prompt.multiline) {
    return "multiline";
  }

  return null;
}
