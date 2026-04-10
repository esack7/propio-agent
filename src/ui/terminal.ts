import {
  formatAssistantGutter,
  formatAssistantPrefix,
  formatAssistantMessage,
  formatInputPrompt,
  formatCommand,
  formatError,
  formatInfo,
  formatSubtle,
  formatSuccess,
  formatUserMessage,
  formatWarning,
} from "./formatting.js";
import { error as colorError, success as colorSuccess } from "./colors.js";
import { symbols } from "./symbols.js";
import { OperationSpinner } from "./spinner.js";
import {
  MarkdownStreamer,
  PassthroughStreamer,
  NullStreamer,
  type Streamer,
} from "./markdownRenderer.js";

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
  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;
  private spinner: OperationSpinner | null = null;
  private pendingStderrLine = false;

  constructor(options: TerminalUiOptions) {
    this.interactive = options.interactive;
    this.plain = options.plain;
    this.json = options.json;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
  }

  getPromptOutputStream(): NodeJS.WriteStream {
    return this.stderr;
  }

  isJsonMode(): boolean {
    return this.json;
  }

  createMarkdownStream(): Streamer {
    // JSON mode: suppress all output
    if (this.json) {
      return new NullStreamer();
    }

    // Plain or non-TTY mode: passthrough without markdown parsing
    if (this.plain || !this.stderr.isTTY) {
      return new PassthroughStreamer((token) => {
        this.writeAssistant(token);
      });
    }

    // Interactive + TTY: use full markdown streaming with rendering
    return new MarkdownStreamer(this.stderr);
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

    this.done();

    if (this.interactive) {
      this.writeStderrLine("");
      const gutter = symbols.prompt === "❯" ? "│ " : "| ";
      this.writeStderr(this.applyStyle(gutter[0] ?? "", formatAssistantPrefix));
      this.writeStderr(this.applyStyle(gutter.slice(1), formatAssistantGutter));
      return;
    }

    this.writeStderr(this.applyStyle("Assistant: ", formatAssistantMessage));
  }

  status(text: string, phase?: string): void {
    if (this.json) {
      return;
    }

    if (!this.interactive || this.plain) {
      this.info(text);
      return;
    }

    const formatted = this.applyStyle(text, formatInfo);
    if (!this.spinner) {
      this.spinner = new OperationSpinner(formatted, {
        enabled: true,
        stream: this.stderr,
        phase,
      });
      this.spinner.start();
      return;
    }

    this.spinner.setPhase(phase ?? null);
    this.spinner.setText(formatted);
  }

  traceStatus(text: string): void {
    if (this.json) {
      return;
    }
    this.done();
    this.writeStderrLine(this.applyStyle(`Status: ${text}`, formatSubtle));
  }

  traceActivity(text: string, level: "info" | "error" = "info"): void {
    if (this.json) {
      return;
    }
    this.done();
    if (level === "error") {
      this.writeStderrLine(this.applyStyle(`Activity: ${text}`, formatError));
      return;
    }
    this.writeStderrLine(this.applyStyle(`Activity: ${text}`, formatInfo));
  }

  reasoningSummary(summary: string, source: "agent" | "provider"): void {
    if (this.json) {
      return;
    }
    this.done();
    this.writeStderrLine("");
    this.writeStderrLine(
      this.applyStyle(
        `Reasoning summary (${source}): ${summary}`,
        formatSubtle,
      ),
    );
  }

  idleFooter(text: string): void {
    if (this.json || !this.interactive) {
      return;
    }
    this.done();
    this.writeStderrLine(this.applyStyle(text, formatSubtle));
  }

  turnComplete(durationMs: number): void {
    if (this.json || !this.interactive) {
      return;
    }
    this.done();
    this.writeStderrLine(
      this.applyStyle(
        `Turn complete in ${formatDurationSeconds(durationMs)}`,
        formatSubtle,
      ),
    );
  }

  info(text: string): void {
    if (this.json) {
      return;
    }
    this.done();
    this.writeStderrLine(this.applyStyle(text, formatInfo));
  }

  command(text: string): void {
    if (this.json) {
      return;
    }
    this.done();
    this.writeStderrLine(this.applyStyle(text, formatCommand));
  }

  subtle(text: string): void {
    if (this.json) {
      return;
    }
    this.done();
    this.writeStderrLine(this.applyStyle(text, formatSubtle));
  }

  warn(text: string): void {
    if (this.json) {
      return;
    }
    this.done();
    this.writeStderrLine(this.applyStyle(text, formatWarning));
  }

  success(text: string): void {
    if (this.json) {
      return;
    }

    if (this.spinner) {
      // ora.succeed() already renders a success symbol, so only apply color here.
      const spinnerFormatted = this.applyStyle(text, colorSuccess);
      this.spinner.succeed(spinnerFormatted);
      this.spinner = null;
      return;
    }

    const formatted = this.applyStyle(text, formatSuccess);
    this.writeStderrLine(formatted);
  }

  error(text: string): void {
    if (this.spinner) {
      // ora.fail() already renders an error symbol, so only apply color here.
      const spinnerFormatted = this.applyStyle(text, colorError);
      this.spinner.fail(spinnerFormatted);
      this.spinner = null;
      return;
    }
    const formatted = this.applyStyle(text, formatError);
    this.writeStderrLine(formatted);
  }

  progress(current: number, total: number, label?: string): void {
    const safeTotal = total <= 0 ? 1 : total;
    const boundedCurrent = Math.max(0, Math.min(current, safeTotal));
    const percentage = Math.floor((boundedCurrent / safeTotal) * 100);
    const progressText = label
      ? `${label} (${boundedCurrent}/${safeTotal}, ${percentage}%)`
      : `${boundedCurrent}/${safeTotal} (${percentage}%)`;
    this.status(progressText);
  }

  section(title: string): void {
    if (this.json) {
      return;
    }
    this.done();
    this.writeStderrLine("");
    this.writeStderrLine(this.applyStyle(title, formatInfo));
  }

  indent(text: string): void {
    if (this.json) {
      return;
    }
    this.done();
    this.writeStderrLine(`  ${text}`);
  }

  writeAssistant(text: string): void {
    if (this.json) {
      return;
    }
    this.done();
    this.writeStderr(this.applyStyle(text, formatAssistantMessage));
  }

  writeJson(value: unknown): void {
    this.done();
    this.writeStdoutLine(JSON.stringify(value, null, 2));
  }

  newline(): void {
    if (this.pendingStderrLine) {
      this.writeStderr("\n");
    }
  }

  done(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
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

  private writeStdoutLine(text: string): void {
    this.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  private writeStderrLine(text: string): void {
    const normalized = text.endsWith("\n") ? text : `${text}\n`;
    this.writeStderr(this.fitToTerminalWidth(normalized));
  }

  private writeStderr(text: string): void {
    this.stderr.write(text);
    this.pendingStderrLine = !text.endsWith("\n");
  }

  private fitToTerminalWidth(text: string): string {
    if (
      !this.stderr.isTTY ||
      !this.stderr.columns ||
      this.stderr.columns < 10
    ) {
      return text;
    }

    const maxWidth = this.stderr.columns - 1;
    const lines = text.split("\n");
    const fitted = lines.flatMap((line) =>
      this.wrapLineAtWordBoundaries(line, maxWidth),
    );
    return fitted.join("\n");
  }

  private wrapLineAtWordBoundaries(line: string, maxWidth: number): string[] {
    if (this.visibleLength(line) <= maxWidth) {
      return [line];
    }

    const words = line.split(" ");
    const wrappedLines: string[] = [];
    let currentLine = "";

    for (const word of words) {
      if (currentLine.length === 0) {
        if (this.visibleLength(word) > maxWidth) {
          wrappedLines.push(word);
        } else {
          currentLine = word;
        }
        continue;
      }

      const candidate = `${currentLine} ${word}`;
      if (this.visibleLength(candidate) <= maxWidth) {
        currentLine = candidate;
        continue;
      }

      wrappedLines.push(currentLine);
      if (this.visibleLength(word) > maxWidth) {
        wrappedLines.push(word);
        currentLine = "";
      } else {
        currentLine = word;
      }
    }

    if (currentLine.length > 0) {
      wrappedLines.push(currentLine);
    }

    return wrappedLines.length > 0 ? wrappedLines : [line];
  }

  private visibleLength(value: string): number {
    return value.replace(/\x1b\[[0-9;]*m/g, "").length;
  }
}

function formatDurationSeconds(durationMs: number): string {
  const safeDurationMs = Math.max(0, durationMs);
  return `${(safeDurationMs / 1000).toFixed(1)}s`;
}
