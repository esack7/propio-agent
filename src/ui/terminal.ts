import { formatInputPrompt, formatUserMessage } from "./formatting.js";
import {
  MarkdownStreamer,
  PassthroughStreamer,
  NullStreamer,
  type Streamer,
} from "./markdownRenderer.js";
import { FooterRenderer } from "./footerRenderer.js";
import { StatusRenderer } from "./statusRenderer.js";
import { TranscriptRenderer } from "./transcriptRenderer.js";
import { TerminalWriter, watchTerminalResize } from "./terminalWriter.js";
import { symbols } from "./symbols.js";
import { ReplRenderer } from "./replRenderer.js";
import {
  ReplUiStore,
  type OverlayState,
  type ReplAppMode,
  type TranscriptEntry,
} from "./replUi.js";
import type { ToolCallView } from "./toolCallView.js";
import type { PromptState } from "./promptState.js";
import { renderTranscriptEntry } from "./transcriptEntryOps.js";

export interface TerminalUiOptions {
  interactive: boolean;
  plain: boolean;
  json: boolean;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export class TerminalUi {
  private readonly interactive: boolean;
  private readonly plain: boolean;
  private readonly json: boolean;
  private readonly writer: TerminalWriter;
  private readonly transcript: TranscriptRenderer;
  private readonly statusRenderer: StatusRenderer;
  private readonly footerRenderer: FooterRenderer;
  private readonly retainedStore: ReplUiStore | null;
  private readonly retainedRenderer: ReplRenderer | null;
  private readonly retainedPromptOutputStream: NodeJS.WriteStream;
  private unwatchResize: () => void = () => {};

  constructor(options: TerminalUiOptions) {
    this.interactive = options.interactive;
    this.plain = options.plain;
    this.json = options.json;
    this.writer = new TerminalWriter({
      stdout: options.stdout,
      stderr: options.stderr,
    });

    const style = this.applyStyle.bind(this);
    const clearStatus = () => this.statusRenderer.clear();

    this.statusRenderer = new StatusRenderer({
      stream: this.writer.getStderrStream(),
      style,
      interactive: this.interactive,
      plain: this.plain,
      json: this.json,
      fallbackInfo: (text) => {
        this.transcript.info(text);
      },
    });
    this.transcript = new TranscriptRenderer({
      writer: this.writer,
      style,
      clearStatus,
      interactive: this.interactive,
      json: this.json,
    });
    this.footerRenderer = new FooterRenderer({
      writer: this.writer,
      style,
      clearStatus,
      interactive: this.interactive,
      json: this.json,
    });

    const useRetainedRenderer =
      this.interactive &&
      !this.plain &&
      !this.json &&
      this.writer.getStderrStream().isTTY;

    this.retainedPromptOutputStream = this.writer.getStderrStream();

    if (useRetainedRenderer) {
      this.retainedStore = new ReplUiStore();
      this.retainedRenderer = new ReplRenderer({
        writer: this.writer,
        transcriptRenderer: this.transcript,
        statusRenderer: this.statusRenderer,
        footerRenderer: this.footerRenderer,
      });
      const retainedStore = this.retainedStore;
      this.retainedStore.subscribe(() => {
        this.retainedRenderer?.flush(retainedStore.getState());
      });
      this.unwatchResize = watchTerminalResize(
        this.writer.getStderrStream(),
        () => {
          const state = retainedStore.getState();
          if (state.prompt) {
            return;
          }

          this.retainedRenderer?.handleResize(state);
        },
      );
    } else {
      this.retainedStore = null;
      this.retainedRenderer = null;
    }
  }

  getPromptOutputStream(): NodeJS.WriteStream {
    return this.retainedPromptOutputStream;
  }

  isJsonMode(): boolean {
    return this.json;
  }

  supportsVisibleThinking(): boolean {
    return this.supportsEphemeralStatus();
  }

  supportsEphemeralStatus(): boolean {
    return (
      this.interactive &&
      !this.plain &&
      !this.json &&
      this.writer.getStderrStream().isTTY
    );
  }

  setMode(mode: ReplAppMode): void {
    if (!this.retainedStore) {
      return;
    }

    this.retainedStore.setMode(mode);
  }

  setPromptState(state: PromptState | null): void {
    if (!this.retainedStore) {
      return;
    }

    this.retainedStore.setPrompt(state);
  }

  createMarkdownStream(): Streamer {
    if (this.json) {
      return new NullStreamer();
    }

    if (this.plain || !this.writer.getStderrStream().isTTY) {
      return new PassthroughStreamer(
        (token) => {
          this.writeAssistant(token);
        },
        () => {
          this.newline();
        },
      );
    }

    return new MarkdownStreamer(this.writer.getStderrStream());
  }

  prompt(text: string): string {
    return this.applyStyle(text, formatUserMessage);
  }

  chatPrompt(): string {
    return this.applyStyle(`${symbols.prompt} `, formatInputPrompt);
  }

  bashPrompt(): string {
    return this.applyStyle("! ", formatInputPrompt);
  }

  bashCommand(text: string): void {
    if (this.json) {
      this.writeJson({ type: "bash_command", command: text });
      return;
    }

    this.appendTranscriptEntry({ kind: "bash_command", text });
  }

  bashOutput(stdout: string, stderr: string, exitCode: number): void {
    if (this.json) {
      if (stdout.length > 0) {
        this.writeJson({ type: "bash_stdout", text: stdout });
      }
      if (stderr.length > 0) {
        this.writeJson({ type: "bash_stderr", text: stderr });
      }
      this.writeJson({ type: "bash_exit", exitCode });
      return;
    }

    if (stdout.length > 0) {
      this.appendTranscriptEntry({ kind: "bash_stdout", text: stdout });
    }
    if (stderr.length > 0) {
      this.appendTranscriptEntry({ kind: "bash_stderr", text: stderr });
    }
    if (exitCode !== 0) {
      this.appendTranscriptEntry({
        kind: "subtle",
        text: `Exit code: ${exitCode}`,
      });
    }
  }

  beginAssistantResponse(): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({ kind: "assistant_start" });
  }

  beginThinkingResponse(): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({ kind: "thinking_start" });
  }

  persistSubmittedInput(text: string): void {
    if (!this.retainedStore || this.json) {
      return;
    }

    // The live prompt already leaves the submitted input visible in retained TTY mode.
    // Avoid writing a second transcript copy and duplicating the user's message.
  }

  status(text: string, phase?: string): void {
    if (this.json) {
      return;
    }

    if (this.retainedStore) {
      this.retainedStore.setStatus({ kind: "status", text, phase });
      return;
    }

    this.statusRenderer.status(text, phase);
  }

  upsertToolCallView(view: ToolCallView): void {
    if (this.json) {
      return;
    }

    if (this.retainedStore) {
      this.retainedStore.upsertToolCallView(view);
      return;
    }

    this.appendToolCallTranscriptEntry(view);
  }

  appendToolCallView(view: ToolCallView): void {
    if (this.json) {
      return;
    }

    this.appendToolCallTranscriptEntry(view);
  }

  private appendToolCallTranscriptEntry(view: ToolCallView): void {
    if (view.status === "running") {
      this.appendTranscriptEntry({ kind: "info", text: `◆ ${view.useLabel}` });
    } else if (view.status === "success") {
      const text = view.resultLabel
        ? `${view.useLabel} — ${view.resultLabel}`
        : view.useLabel;
      this.appendTranscriptEntry({ kind: "success", text });
    } else {
      const text = view.resultLabel
        ? `${view.useLabel} — ${view.resultLabel}`
        : view.useLabel;
      this.appendTranscriptEntry({ kind: "error", text });
    }
  }

  traceStatus(text: string): void {
    if (this.json) {
      return;
    }

    if (this.retainedStore) {
      this.retainedStore.setStatus({ kind: "status", text });
      return;
    }

    this.appendTranscriptEntry({ kind: "subtle", text: `Status: ${text}` });
  }

  reasoningSummary(summary: string, source: "agent" | "provider"): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({
      kind: "reasoning_summary",
      summary,
      source,
    });
  }

  idleFooter(text: string): void {
    if (this.json) {
      return;
    }

    if (this.retainedStore) {
      this.retainedStore.setFooter(text);
      return;
    }

    this.footerRenderer.idleFooter(text);
  }

  turnComplete(durationMs: number): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({ kind: "turn_complete", durationMs });
  }

  turnFailed(durationMs: number): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({ kind: "turn_failed", durationMs });
  }

  info(text: string): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({ kind: "info", text });
  }

  command(text: string): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({ kind: "command", text });
  }

  subtle(text: string): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({ kind: "subtle", text });
  }

  warn(text: string): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({ kind: "warn", text });
  }

  success(text: string): void {
    if (this.json) {
      return;
    }

    if (this.statusRenderer.succeed(text)) {
      if (this.retainedStore) {
        this.retainedStore.setStatus(null);
      }
      return;
    }

    this.appendTranscriptEntry({ kind: "success", text });
  }

  error(text: string): void {
    if (this.json) {
      return;
    }

    if (this.statusRenderer.fail(text)) {
      if (this.retainedStore) {
        this.retainedStore.setStatus(null);
      }
      return;
    }

    this.appendTranscriptEntry({ kind: "error", text });
  }

  // fallow-ignore-next-line unused-class-member
  progress(current: number, total: number, label?: string): void {
    if (this.json) {
      return;
    }

    if (this.retainedStore) {
      this.retainedStore.setStatus({
        kind: "progress",
        current,
        total,
        label,
      });
      return;
    }

    this.statusRenderer.progress(current, total, label);
  }

  // fallow-ignore-next-line unused-class-member
  section(title: string): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({ kind: "section", text: title });
  }

  // fallow-ignore-next-line unused-class-member
  indent(text: string): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({ kind: "indent", text });
  }

  writeAssistant(text: string): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({ kind: "assistant_token", text });
  }

  writeThinking(text: string): void {
    if (this.json) {
      return;
    }

    this.appendTranscriptEntry({ kind: "thinking_token", text });
  }

  writeJson(value: unknown): void {
    this.clearStatusIfNeeded();
    this.transcript.writeJson(value);
  }

  openOverlay(overlay: OverlayState): void {
    if (this.json) {
      return;
    }

    if (this.retainedStore) {
      this.retainedStore.openOverlay(overlay);
      return;
    }

    this.renderOverlayEntries(overlay.entries);
  }

  closeOverlay(): void {
    if (this.retainedStore) {
      this.retainedStore.closeOverlay();
    }
  }

  newline(): void {
    this.writer.newline();
  }

  done(): void {
    this.clearStatusIfNeeded();
  }

  clearEphemeralSurfaces(): void {
    if (this.retainedStore) {
      const state = this.retainedStore.getState();
      if (state.status || state.toolCallViews.size > 0) {
        this.retainedStore.clearEphemeralSurfaces();
      }
      return;
    }

    this.statusRenderer.clear();
  }

  cleanup(): void {
    this.done();
    this.newline();
    this.unwatchResize();
    this.unwatchResize = () => {};
  }

  private clearStatusIfNeeded(): void {
    if (this.retainedStore) {
      const state = this.retainedStore.getState();
      if (state.status) {
        this.retainedStore.clearEphemeralSurfaces();
      }
      return;
    }

    this.statusRenderer.clear();
  }

  private appendTranscriptEntry(entry: TranscriptEntry): void {
    if (this.retainedStore) {
      this.retainedStore.appendTranscriptEntry(entry);
      return;
    }

    renderTranscriptEntry(this.transcript, entry);
  }

  private renderOverlayEntries(entries: readonly TranscriptEntry[]): void {
    for (const entry of entries) {
      renderTranscriptEntry(this.transcript, entry);
    }
  }

  private applyStyle(
    text: string,
    formatter: (value: string) => string,
  ): string {
    if (this.plain || this.json) {
      return text;
    }
    return formatter(text);
  }
}
