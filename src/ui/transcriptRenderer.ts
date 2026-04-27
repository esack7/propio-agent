import {
  formatAssistantMessage,
  formatCommand,
  formatError,
  formatInfo,
  formatInputPrompt,
  formatSubtle,
  formatSuccess,
  formatUserMessage,
  formatWarning,
} from "./formatting.js";
import { symbols } from "./symbols.js";
import type { TerminalWriter } from "./terminalWriter.js";

type StyleFn = (text: string, formatter: (value: string) => string) => string;

export interface TranscriptRendererOptions {
  writer: TerminalWriter;
  style: StyleFn;
  clearStatus: () => void;
  interactive: boolean;
  json: boolean;
}

function formatDurationSeconds(durationMs: number): string {
  const safeDurationMs = Math.max(0, durationMs);
  return `${(safeDurationMs / 1000).toFixed(1)}s`;
}

export class TranscriptRenderer {
  constructor(private readonly options: TranscriptRendererOptions) {}

  userMessage(text: string): void {
    this.options.clearStatus();

    if (!this.options.interactive) {
      this.options.writer.writeStderrLine(text);
      return;
    }

    const prompt = symbols.prompt === "❯" ? "❯ " : `${symbols.prompt} `;
    const continuation = " ".repeat(prompt.length);
    const lines = text.split("\n");

    lines.forEach((line, index) => {
      const prefix = index === 0 ? prompt : continuation;
      const styledPrefix = this.options.style(prefix, formatInputPrompt);
      const styledLine = this.options.style(line, formatUserMessage);
      this.options.writer.writeStderrLine(`${styledPrefix}${styledLine}`);
    });
  }

  beginAssistantResponse(): void {
    this.options.clearStatus();

    if (this.options.interactive) {
      this.options.writer.writeStderrLine("");
      return;
    }

    this.options.writer.writeStderr(
      this.options.style("Assistant: ", formatAssistantMessage),
    );
  }

  traceStatus(text: string): void {
    this.options.clearStatus();
    this.options.writer.writeStderrLine(
      this.options.style(`Status: ${text}`, formatSubtle),
    );
  }

  traceActivity(text: string, level: "info" | "error" = "info"): void {
    this.options.clearStatus();
    const formatter = level === "error" ? formatError : formatInfo;
    this.options.writer.writeStderrLine(
      this.options.style(`Activity: ${text}`, formatter),
    );
  }

  reasoningSummary(summary: string, source: "agent" | "provider"): void {
    this.options.clearStatus();
    this.options.writer.writeStderrLine("");
    this.options.writer.writeStderrLine(
      this.options.style(
        `Reasoning summary (${source}): ${summary}`,
        formatSubtle,
      ),
    );
  }

  info(text: string): void {
    this.options.clearStatus();
    this.options.writer.writeStderrLine(this.options.style(text, formatInfo));
  }

  command(text: string): void {
    this.options.clearStatus();
    this.options.writer.writeStderrLine(
      this.options.style(text, formatCommand),
    );
  }

  subtle(text: string): void {
    this.options.clearStatus();
    this.options.writer.writeStderrLine(this.options.style(text, formatSubtle));
  }

  warn(text: string): void {
    this.options.clearStatus();
    this.options.writer.writeStderrLine(
      this.options.style(text, formatWarning),
    );
  }

  success(text: string): void {
    this.options.clearStatus();
    this.options.writer.writeStderrLine(
      this.options.style(text, formatSuccess),
    );
  }

  error(text: string): void {
    this.options.clearStatus();
    this.options.writer.writeStderrLine(this.options.style(text, formatError));
  }

  section(title: string): void {
    this.options.clearStatus();
    this.options.writer.writeStderrLine("");
    this.options.writer.writeStderrLine(this.options.style(title, formatInfo));
  }

  indent(text: string): void {
    this.options.clearStatus();
    this.options.writer.writeStderrLine(`  ${text}`);
  }

  writeAssistant(text: string): void {
    this.options.clearStatus();
    this.options.writer.writeStderr(
      this.options.style(text, formatAssistantMessage),
    );
  }

  writeJson(value: unknown): void {
    this.options.clearStatus();
    this.options.writer.writeStdoutLine(JSON.stringify(value, null, 2));
  }

  turnComplete(durationMs: number): void {
    if (this.options.json || !this.options.interactive) {
      return;
    }

    this.options.clearStatus();
    this.options.writer.writeStderrLine(
      this.options.style(
        `Turn complete in ${formatDurationSeconds(durationMs)}`,
        formatSubtle,
      ),
    );
  }
}
