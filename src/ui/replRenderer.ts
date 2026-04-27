import { FooterRenderer } from "./footerRenderer.js";
import { StatusRenderer } from "./statusRenderer.js";
import { TranscriptRenderer } from "./transcriptRenderer.js";
import type { TerminalWriter } from "./terminalWriter.js";
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

    if (state.footer && state.prompt?.mode === "chat") {
      this.options.footerRenderer.idleFooter(state.footer);
      renderedLines += 1;
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

function countWrittenStderrLines(text: string, writer: TerminalWriter): number {
  const fitted = writer.fitToTerminalWidth(
    text.endsWith("\n") ? text : `${text}\n`,
  );
  const trimmed = fitted.endsWith("\n") ? fitted.slice(0, -1) : fitted;
  return Math.max(1, trimmed.split("\n").length);
}
