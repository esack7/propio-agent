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
 * Strip trailing ANSI SGR codes and whitespace from a string.
 * marked-terminal appends reset codes + newlines after each block,
 * and these shift rightward as content grows. Stripping them gives
 * a stable prefix we can diff against.
 */
function stripTrailingAnsi(str: string): string {
  return str.replace(/(\x1b\[\d*(;\d+)*m|\s)*$/, "");
}

/**
 * MarkdownStreamer buffers streaming tokens and renders them as markdown
 * using marked + marked-terminal with append-only delta rendering.
 *
 * Key features:
 * - Throttled rendering (~80ms) to batch token arrivals without starvation
 * - Full buffer re-parse on each render (markdown is context-sensitive)
 * - Append-only output: only writes new content, no cursor rewind needed
 * - Works reliably regardless of content length or terminal scrolling
 */
export class MarkdownStreamer implements Streamer {
  private buffer: string = "";
  private committedOutput: string = "";
  private throttleTimerId: NodeJS.Timeout | null = null;
  private lastRenderTime: number = 0;
  private readonly stderr: NodeJS.WriteStream;
  private readonly renderIntervalMs: number;
  private readonly marked: Marked;

  constructor(stderr: NodeJS.WriteStream, renderIntervalMs: number = 80) {
    this.stderr = stderr;
    this.renderIntervalMs = renderIntervalMs;
    this.marked = createMarkedInstance(stderr);
  }

  push(token: string): void {
    this.buffer += token;
    this.scheduleRender();
  }

  flush(): void {
    this.cancelThrottle();
    this.renderFinal();
    this.buffer = "";
    this.committedOutput = "";
  }

  finish(): void {
    this.cancelThrottle();
    this.renderFinal();
    this.buffer = "";
    this.committedOutput = "";
  }

  /**
   * Schedule a throttled render. Unlike debounce, this guarantees
   * a render fires within renderIntervalMs even during continuous pushes.
   */
  private scheduleRender(): void {
    if (this.throttleTimerId !== null) {
      return;
    }

    const elapsed = Date.now() - this.lastRenderTime;
    const delay = Math.max(0, this.renderIntervalMs - elapsed);

    this.throttleTimerId = setTimeout(() => {
      this.throttleTimerId = null;
      this.render();
    }, delay);
  }

  /**
   * Delta render. Parses the full buffer, strips trailing ANSI resets,
   * and writes only the new content since the last render. On divergence
   * (inline formatting change), rewinds to the last newline boundary
   * and rewrites from there.
   */
  private render(): void {
    if (this.buffer.length === 0) {
      return;
    }

    this.lastRenderTime = Date.now();

    const parsed = this.parseBufferSafely(this.buffer);
    const stripped = stripTrailingAnsi(parsed);

    if (stripped.startsWith(this.committedOutput)) {
      const delta = stripped.substring(this.committedOutput.length);
      if (delta.length > 0) {
        this.stderr.write(delta);
        this.committedOutput = stripped;
      }
    } else {
      this.rewriteFromDivergence(stripped);
    }
  }

  /**
   * Final render for flush/finish: writes the complete parsed output
   * including trailing ANSI resets and newlines that were stripped
   * during streaming renders.
   */
  private renderFinal(): void {
    if (this.buffer.length === 0) {
      return;
    }

    this.lastRenderTime = Date.now();

    const parsed = this.parseBufferSafely(this.buffer);
    const stripped = stripTrailingAnsi(parsed);

    // Handle divergence first if needed
    if (!stripped.startsWith(this.committedOutput)) {
      this.rewriteFromDivergence(stripped);
    } else {
      const delta = stripped.substring(this.committedOutput.length);
      if (delta.length > 0) {
        this.stderr.write(delta);
        this.committedOutput = stripped;
      }
    }

    // Write trailing ANSI resets and newlines that were stripped during streaming
    const trailing = parsed.substring(stripped.length);
    if (trailing.length > 0) {
      this.stderr.write(trailing);
    }
  }

  /**
   * Handle divergence by rewinding to the last newline boundary in the
   * common prefix and rewriting from there.
   */
  private rewriteFromDivergence(newStripped: string): void {
    const commonLen = this.findCommonPrefixLength(
      this.committedOutput,
      newStripped,
    );

    // Find the last newline at or before the divergence point
    const rewindTo = this.committedOutput.lastIndexOf("\n", commonLen);

    // Count newlines in committed output after the rewind point
    // to know how many visual lines to move the cursor up
    let linesUp = 0;
    for (let i = rewindTo + 1; i < this.committedOutput.length; i++) {
      if (this.committedOutput.charCodeAt(i) === 10) linesUp++;
    }

    // Rewind cursor to the line boundary
    if (linesUp > 0) {
      this.stderr.write(`\x1b[${linesUp}A`);
    }
    this.stderr.write("\r\x1b[0J");

    // Write everything from the rewind point onward
    const newContent = newStripped.substring(rewindTo + 1);
    if (newContent.length > 0) {
      this.stderr.write(newContent);
    }
    this.committedOutput = newStripped;
  }

  private findCommonPrefixLength(a: string, b: string): number {
    const len = Math.min(a.length, b.length);
    let i = 0;
    while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) {
      i++;
    }
    return i;
  }

  private cancelThrottle(): void {
    if (this.throttleTimerId !== null) {
      clearTimeout(this.throttleTimerId);
      this.throttleTimerId = null;
    }
  }

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
