import { Marked } from "marked";
import { markedTerminal, type TerminalOptions } from "marked-terminal";
import chalk from "chalk";

/**
 * Interface for streamer objects that handle markdown rendering
 */
export interface Streamer {
  push(token: string): void;
  flush(): void;
  finish(): void;
}

function createMarkedInstance(stderr: NodeJS.WriteStream): Marked {
  // Return a fresh instance each time to avoid state pollution
  const marked = new Marked();

  // Configure terminal rendering options
  const terminalOptions: TerminalOptions = {
    // Atom Dark color palette
    h1: (text: string) => chalk.bold(chalk.hex("#61AFEF")(text)),
    h2: (text: string) => chalk.bold(chalk.hex("#61AFEF")(text)),
    h3: (text: string) => chalk.bold(chalk.hex("#61AFEF")(text)),
    h4: (text: string) => chalk.bold(chalk.hex("#61AFEF")(text)),
    h5: (text: string) => chalk.bold(chalk.hex("#61AFEF")(text)),
    h6: (text: string) => chalk.bold(chalk.hex("#61AFEF")(text)),

    // Code: yellow
    codespan: (text: string) => chalk.hex("#E5C07B")(text),
    code: (_text: string, _lang?: string) => chalk.hex("#E5C07B")(_text),

    // Body text: light gray
    paragraph: (text: string) => chalk.hex("#ABB2BF")(text),

    // Lists: light gray
    listitem: (text: string) => chalk.hex("#ABB2BF")(text),

    // Blockquotes: subtle gray + italic
    blockquote: (text: string) => chalk.italic(chalk.hex("#5C6370")(text)),

    // Links: blue
    link: (_href: string, _title: string, text: string) =>
      chalk.hex("#61AFEF")(text),

    // Bold and italic
    strong: (text: string) => chalk.bold(text),
    em: (text: string) => chalk.italic(text),

    // Terminal width and reflow
    width: Math.max((stderr.columns ?? 80) - 1, 40),
    reflowText: true,
  };

  // Use the terminal renderer - markedTerminal() returns renderer config
  const rendererConfig = markedTerminal(terminalOptions);
  marked.use(rendererConfig);
  marked.use({ breaks: true });

  return marked;
}

/**
 * MarkdownStreamer buffers streaming tokens and renders them as markdown
 * using marked + marked-terminal with ANSI cursor control for smooth re-renders.
 *
 * Key features:
 * - Debounced rendering (~50ms) to batch token arrivals
 * - Full buffer re-parse on each render (markdown is context-sensitive)
 * - ANSI cursor rewind to replace previous output
 * - Cursor visibility control to prevent flicker
 * - Immediate flush/finish rendering
 */
export class MarkdownStreamer implements Streamer {
  private buffer: string = "";
  private previousLineCount: number = 0;
  private debounceTimerId: NodeJS.Timeout | null = null;
  private readonly stderr: NodeJS.WriteStream;
  private readonly debounceMs: number = 50;
  private readonly marked: Marked;

  constructor(stderr: NodeJS.WriteStream, debounceMs: number = 50) {
    this.stderr = stderr;
    this.debounceMs = debounceMs;
    this.marked = createMarkedInstance(stderr);
  }

  /**
   * Add a token to the buffer and schedule a debounced re-render
   */
  push(token: string): void {
    this.buffer += token;
    this.scheduleRender();
  }

  /**
   * Render immediately, commit output, and clear the buffer
   */
  flush(): void {
    this.cancelDebounce();
    this.render();
    this.commitOutput();
    this.buffer = "";
  }

  /**
   * Flush, restore cursor visibility, and clean up
   */
  finish(): void {
    this.cancelDebounce();
    this.render();
    this.commitOutput();
    this.restoreCursor();
  }

  /**
   * Schedule a debounced re-render
   */
  private scheduleRender(): void {
    // Cancel any pending timer
    if (this.debounceTimerId !== null) {
      clearTimeout(this.debounceTimerId);
    }

    // Schedule new render
    this.debounceTimerId = setTimeout(() => {
      this.render();
      this.debounceTimerId = null;
    }, this.debounceMs);
  }

  /**
   * Render the current buffer to stderr with cursor control
   */
  private render(): void {
    // Don't render if buffer is empty
    if (this.buffer.length === 0) {
      return;
    }

    // Hide cursor before manipulation
    this.hideCursor();

    // Move cursor up and clear if we have previous output
    if (this.previousLineCount > 0) {
      // Move cursor up N lines
      this.stderr.write(`\x1b[${this.previousLineCount}A`);
      // Clear from cursor to end of screen
      this.stderr.write("\x1b[0J");
    }

    // Parse and render the markdown
    const parsed = this.parseBufferSafely(this.buffer);
    this.stderr.write(parsed);

    // Count the lines in the rendered output (for next rewind)
    this.previousLineCount = parsed.split("\n").length - 1;

    // Show cursor after write
    this.showCursor();
  }

  /**
   * Commit the output (reset line count)
   */
  private commitOutput(): void {
    this.previousLineCount = 0;
  }

  /**
   * Cancel any pending debounce timer
   */
  private cancelDebounce(): void {
    if (this.debounceTimerId !== null) {
      clearTimeout(this.debounceTimerId);
      this.debounceTimerId = null;
    }
  }

  /**
   * Hide cursor (ANSI sequence)
   */
  private hideCursor(): void {
    this.stderr.write("\x1b[?25l");
  }

  /**
   * Show cursor (ANSI sequence)
   */
  private showCursor(): void {
    this.stderr.write("\x1b[?25h");
  }

  /**
   * Restore cursor visibility when cleaning up
   */
  private restoreCursor(): void {
    this.showCursor();
  }

  /**
   * Parse markdown to terminal-formatted text with fallback for parser errors.
   */
  private parseBufferSafely(buffer: string): string {
    try {
      const parsed = this.marked.parse(buffer);
      return typeof parsed === "string" ? parsed : buffer;
    } catch {
      return buffer;
    }
  }
}

/**
 * PassthroughStreamer writes tokens directly without buffering or markdown parsing.
 * Used for plain-text modes.
 */
export class PassthroughStreamer implements Streamer {
  private readonly writeCallback: (token: string) => void;

  constructor(writeCallback: (token: string) => void) {
    this.writeCallback = writeCallback;
  }

  push(token: string): void {
    this.writeCallback(token);
  }

  flush(): void {
    // No-op
  }

  finish(): void {
    // No-op
  }
}

/**
 * NullStreamer suppresses all output.
 * Used for JSON mode.
 */
export class NullStreamer implements Streamer {
  push(_token: string): void {
    // No-op
  }

  flush(): void {
    // No-op
  }

  finish(): void {
    // No-op
  }
}
