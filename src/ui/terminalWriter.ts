export interface TerminalWriterOptions {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export function visibleLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function wrapTextToWidth(line: string, maxWidth: number): string[] {
  if (visibleLength(line) <= maxWidth) {
    return [line];
  }

  const words = line.split(" ");
  const wrappedLines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length === 0) {
      if (visibleLength(word) > maxWidth) {
        wrappedLines.push(word);
      } else {
        currentLine = word;
      }
      continue;
    }

    const candidate = `${currentLine} ${word}`;
    if (visibleLength(candidate) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    wrappedLines.push(currentLine);
    if (visibleLength(word) > maxWidth) {
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

export class TerminalWriter {
  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;
  private pendingStderrLine = false;

  constructor(options: TerminalWriterOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
  }

  getStdoutStream(): NodeJS.WriteStream {
    return this.stdout;
  }

  getStderrStream(): NodeJS.WriteStream {
    return this.stderr;
  }

  writeStdoutLine(text: string): void {
    this.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  writeStderrLine(text: string): void {
    const normalized = text.endsWith("\n") ? text : `${text}\n`;
    this.writeStderr(this.fitToTerminalWidth(normalized));
  }

  writeStderr(text: string): void {
    this.stderr.write(text);
    this.pendingStderrLine = !text.endsWith("\n");
  }

  newline(): void {
    if (this.pendingStderrLine) {
      this.writeStderr("\n");
    }
  }

  fitToTerminalWidth(text: string): string {
    if (
      !this.stderr.isTTY ||
      !this.stderr.columns ||
      this.stderr.columns < 10
    ) {
      return text;
    }

    const maxWidth = this.stderr.columns - 1;
    const lines = text.split("\n");
    const fitted = lines.flatMap((line) => wrapTextToWidth(line, maxWidth));
    return fitted.join("\n");
  }
}
