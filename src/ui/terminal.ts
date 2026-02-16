import {
  formatAssistantMessage,
  formatCommand,
  formatError,
  formatInfo,
  formatSubtle,
  formatSuccess,
  formatUserMessage,
  formatWarning,
} from "./formatting.js";
import { OperationSpinner } from "./spinner.js";

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

  prompt(text: string): string {
    return this.applyStyle(text, formatUserMessage);
  }

  status(text: string): void {
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
      });
      this.spinner.start();
      return;
    }

    this.spinner.setText(formatted);
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

    const formatted = this.applyStyle(text, formatSuccess);
    if (this.spinner) {
      this.spinner.succeed(formatted);
      this.spinner = null;
      return;
    }

    this.writeStderrLine(formatted);
  }

  error(text: string): void {
    const formatted = this.applyStyle(text, formatError);
    if (this.spinner) {
      this.spinner.fail(formatted);
      this.spinner = null;
      return;
    }
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
    const fitted = lines.map((line) => {
      if (line.length <= maxWidth) {
        return line;
      }
      return `${line.slice(0, maxWidth - 1)}…`;
    });
    return fitted.join("\n");
  }
}
