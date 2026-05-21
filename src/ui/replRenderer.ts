import { FooterRenderer } from "./footerRenderer.js";
import { StatusRenderer } from "./statusRenderer.js";
import { TranscriptRenderer } from "./transcriptRenderer.js";
import type { TerminalWriter } from "./terminalWriter.js";
import type {
  EphemeralStatus,
  OverlayState,
  ReplUiState,
  TranscriptEntry,
} from "./replUi.js";
import type { ToolCallView } from "./toolCallView.js";
import {
  formatToolExecution,
  formatSuccess,
  formatError,
} from "./formatting.js";
import {
  countTranscriptEntryStderrLines,
  renderTranscriptEntry,
  transcriptEntriesEqual,
} from "./transcriptEntryOps.js";

export interface ReplRendererOptions {
  writer: TerminalWriter;
  transcriptRenderer: TranscriptRenderer;
  statusRenderer: StatusRenderer;
  footerRenderer: FooterRenderer;
}

function statusEntriesEqual(
  left: Extract<EphemeralStatus, { kind: "status" }>,
  right: Extract<EphemeralStatus, { kind: "status" }>,
): boolean {
  return left.text === right.text && left.phase === right.phase;
}

function progressEntriesEqual(
  left: Extract<EphemeralStatus, { kind: "progress" }>,
  right: Extract<EphemeralStatus, { kind: "progress" }>,
): boolean {
  return (
    left.current === right.current &&
    left.total === right.total &&
    left.label === right.label
  );
}

function statusesEqual(
  left: EphemeralStatus | null,
  right: EphemeralStatus | null,
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right || left.kind !== right.kind) {
    return false;
  }

  if (left.kind === "status" && right.kind === "status") {
    return statusEntriesEqual(left, right);
  }

  if (left.kind === "progress" && right.kind === "progress") {
    return progressEntriesEqual(left, right);
  }

  return false;
}

function overlaysEqual(
  left: OverlayState | null,
  right: OverlayState | null,
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right || left.kind !== right.kind) {
    return false;
  }

  if (left.entries.length !== right.entries.length) {
    return false;
  }

  return left.entries.every((entry, index) =>
    transcriptEntriesEqual(entry, right.entries[index]),
  );
}

export class ReplRenderer {
  private previousState: ReplUiState | null = null;
  private renderedBottomLineCount = 0;

  constructor(private readonly options: ReplRendererOptions) {}

  flush(nextState: ReplUiState): void {
    const previousState = this.previousState;
    this.clearStatusWhenRemoved(previousState, nextState);
    this.renderStatusWhenChanged(previousState, nextState);

    const previousTranscriptLength = previousState?.transcript.length ?? 0;
    const transcriptAppended =
      nextState.transcript.length > previousTranscriptLength;
    const bottomSignatureChanged = bottomZoneSignatureChanged(
      previousState,
      nextState,
    );

    this.clearBottomZoneIfNeeded(bottomSignatureChanged, transcriptAppended);
    this.appendTranscriptSlice(
      nextState.transcript.slice(previousTranscriptLength),
    );
    this.repaintBottomZoneIfNeeded(
      nextState,
      bottomSignatureChanged,
      transcriptAppended,
    );

    this.previousState = nextState;
  }

  private clearStatusWhenRemoved(
    previousState: ReplUiState | null,
    nextState: ReplUiState,
  ): void {
    if (previousState?.status && !nextState.status) {
      this.options.statusRenderer.clear();
    }
  }

  private renderStatusWhenChanged(
    previousState: ReplUiState | null,
    nextState: ReplUiState,
  ): void {
    if (!statusesEqual(previousState?.status ?? null, nextState.status)) {
      this.renderStatus(nextState.status);
    }
  }

  private clearBottomZoneIfNeeded(
    bottomSignatureChanged: boolean,
    transcriptAppended: boolean,
  ): void {
    if (
      this.renderedBottomLineCount > 0 &&
      (bottomSignatureChanged || transcriptAppended)
    ) {
      this.options.writer.clearStderrLines(this.renderedBottomLineCount);
      this.renderedBottomLineCount = 0;
    }
  }

  private appendTranscriptSlice(entries: readonly TranscriptEntry[]): void {
    for (const entry of entries) {
      renderTranscriptEntry(this.options.transcriptRenderer, entry);
    }
  }

  private repaintBottomZoneIfNeeded(
    nextState: ReplUiState,
    bottomSignatureChanged: boolean,
    transcriptAppended: boolean,
  ): void {
    if (bottomSignatureChanged || transcriptAppended) {
      this.renderedBottomLineCount = this.renderBottomZone(nextState);
    }
  }

  handleResize(nextState: ReplUiState): void {
    if (this.renderedBottomLineCount > 0) {
      this.options.writer.clearStderrLines(
        Math.max(
          this.renderedBottomLineCount,
          countBottomZoneLines(nextState, this.options.writer),
        ),
      );
      this.renderedBottomLineCount = 0;
    }

    this.options.statusRenderer.clear();
    this.renderStatus(nextState.status);
    this.renderedBottomLineCount = this.renderBottomZone(nextState);
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

  private renderOverlay(overlay: OverlayState | null): void {
    if (!overlay) {
      return;
    }

    for (const entry of overlay.entries) {
      if (entry.kind === "json") {
        this.options.writer.writeStderrLine(
          JSON.stringify(entry.value, null, 2),
        );
        continue;
      }

      renderTranscriptEntry(this.options.transcriptRenderer, entry);
    }
  }

  private renderBottomZone(state: ReplUiState): number {
    let renderedLines = 0;

    const lastToolCallView = lastMapValue(state.toolCallViews);
    if (lastToolCallView) {
      const text = renderToolCallViewText(lastToolCallView);
      this.options.writer.writeStderrLine(text);
      renderedLines += countWrittenStderrLines(text, this.options.writer);
    }

    if (state.overlay) {
      this.renderOverlay(state.overlay);
      renderedLines += countOverlayLines(state.overlay, this.options.writer);
    }

    if (state.footer && state.prompt?.mode === "chat") {
      this.options.footerRenderer.idleFooter(state.footer);
      renderedLines += countWrittenStderrLines(
        state.footer,
        this.options.writer,
      );
    }

    return renderedLines;
  }
}

function countBottomZoneLines(
  state: ReplUiState,
  writer: TerminalWriter,
): number {
  let count = 0;

  const lastToolCallView = lastMapValue(state.toolCallViews);
  if (lastToolCallView) {
    count += countWrittenStderrLines(
      renderToolCallViewText(lastToolCallView),
      writer,
    );
  }

  if (state.overlay) {
    count += countOverlayLines(state.overlay, writer);
  }

  if (state.footer && state.prompt?.mode === "chat") {
    count += countWrittenStderrLines(state.footer, writer);
  }

  return count;
}

function bottomZoneSignatureChanged(
  previousState: ReplUiState | null,
  nextState: ReplUiState,
): boolean {
  return (
    previousState?.toolCallViewsVersion !== nextState.toolCallViewsVersion ||
    previousState?.footer !== nextState.footer ||
    !overlaysEqual(previousState?.overlay ?? null, nextState.overlay)
  );
}

function countOverlayLines(
  overlay: OverlayState,
  writer: TerminalWriter,
): number {
  let count = 0;

  for (const entry of overlay.entries) {
    count += countTranscriptEntryStderrLines(
      entry,
      writer,
      countWrittenStderrLines,
    );
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

function lastMapValue<V>(map: ReadonlyMap<string, V>): V | undefined {
  let last: V | undefined;
  for (const v of map.values()) {
    last = v;
  }
  return last;
}

function renderToolCallViewText(view: ToolCallView): string {
  if (view.status === "running") {
    return formatToolExecution(view.useLabel);
  }
  const label = view.resultLabel
    ? `${view.useLabel} — ${view.resultLabel}`
    : view.useLabel;
  return view.status === "success" ? formatSuccess(label) : formatError(label);
}
