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
import { TerminalWriter } from "./terminalWriter.js";
import { symbols } from "./symbols.js";

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
  }

  getPromptOutputStream(): NodeJS.WriteStream {
    return this.writer.getStderrStream();
  }

  isJsonMode(): boolean {
    return this.json;
  }

  createMarkdownStream(): Streamer {
    if (this.json) {
      return new NullStreamer();
    }

    if (this.plain || !this.writer.getStderrStream().isTTY) {
      return new PassthroughStreamer((token) => {
        this.writeAssistant(token);
      });
    }

    return new MarkdownStreamer(this.writer.getStderrStream());
  }

  prompt(text: string): string {
    return this.applyStyle(text, formatUserMessage);
  }

  chatPrompt(): string {
    return this.applyStyle(`${symbols.prompt} `, formatInputPrompt);
  }

  beginAssistantResponse(): void {
    if (this.json) {
      return;
    }

    this.transcript.beginAssistantResponse();
  }

  status(text: string, phase?: string): void {
    this.statusRenderer.status(text, phase);
  }

  traceStatus(text: string): void {
    if (this.json) {
      return;
    }

    this.transcript.traceStatus(text);
  }

  traceActivity(text: string, level: "info" | "error" = "info"): void {
    if (this.json) {
      return;
    }

    this.transcript.traceActivity(text, level);
  }

  reasoningSummary(summary: string, source: "agent" | "provider"): void {
    if (this.json) {
      return;
    }

    this.transcript.reasoningSummary(summary, source);
  }

  idleFooter(text: string): void {
    this.footerRenderer.idleFooter(text);
  }

  turnComplete(durationMs: number): void {
    this.transcript.turnComplete(durationMs);
  }

  info(text: string): void {
    if (this.json) {
      return;
    }

    this.transcript.info(text);
  }

  command(text: string): void {
    if (this.json) {
      return;
    }

    this.transcript.command(text);
  }

  subtle(text: string): void {
    if (this.json) {
      return;
    }

    this.transcript.subtle(text);
  }

  warn(text: string): void {
    if (this.json) {
      return;
    }

    this.transcript.warn(text);
  }

  success(text: string): void {
    if (this.json) {
      return;
    }

    if (this.statusRenderer.succeed(text)) {
      return;
    }

    this.transcript.success(text);
  }

  error(text: string): void {
    if (this.json) {
      return;
    }

    if (this.statusRenderer.fail(text)) {
      return;
    }

    this.transcript.error(text);
  }

  progress(current: number, total: number, label?: string): void {
    this.statusRenderer.progress(current, total, label);
  }

  section(title: string): void {
    if (this.json) {
      return;
    }

    this.transcript.section(title);
  }

  indent(text: string): void {
    if (this.json) {
      return;
    }

    this.transcript.indent(text);
  }

  writeAssistant(text: string): void {
    if (this.json) {
      return;
    }

    this.transcript.writeAssistant(text);
  }

  writeJson(value: unknown): void {
    this.transcript.writeJson(value);
  }

  newline(): void {
    this.writer.newline();
  }

  done(): void {
    this.statusRenderer.clear();
  }

  cleanup(): void {
    this.done();
    this.newline();
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
