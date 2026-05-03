import { marked, type Token, type Tokens } from "marked";
import { highlight, supportsLanguage } from "cli-highlight";
import chalk from "chalk";
import { watchTerminalResize } from "./terminalWriter.js";

// ─── Core Utilities ──────────────────────────────────────────────────────────

export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, (char, offset, str) => {
    const code = char.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — valid if followed by a low surrogate
      const next = str.charCodeAt(offset + 1);
      if (next >= 0xdc00 && next <= 0xdfff) return char;
    } else {
      // Low surrogate — valid if preceded by a high surrogate
      const prev = str.charCodeAt(offset - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) return char;
    }
    return "";
  });
}

function visibleLength(str: string): number {
  return str.replace(/\x1b\[[^m]*m/g, "").length;
}

function wrapTextToWidth(line: string, width: number): string[] {
  if (visibleLength(line) <= width) {
    return [line];
  }

  const words = line.split(" ");
  const result: string[] = [];
  let current = "";

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (visibleLength(test) <= width) {
      current = test;
    } else {
      if (current) result.push(current);
      current = word;
    }
  }

  if (current) result.push(current);
  return result.length > 0 ? result : [line];
}

// ─── Theme ───────────────────────────────────────────────────────────────────

export interface MarkdownTheme {
  heading: (text: string, depth: number) => string;
  link: (text: string) => string;
  linkUrl: (url: string) => string;
  code: (text: string) => string;
  codeBlock: (line: string) => string;
  codeBlockBorder: string;
  quote: (text: string) => string;
  quoteBorder: string;
  hr: string;
  listBullet: string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  highlightCode: (code: string, lang?: string) => string[];
  codeBlockIndent: string;
}

export function defaultTheme(width: number): MarkdownTheme {
  return {
    heading: (text, depth) => {
      const prefix = "#".repeat(depth) + " ";
      return chalk.bold(chalk.hex("#61AFEF")(prefix + text));
    },
    link: (text) => chalk.hex("#61AFEF")(text),
    linkUrl: (url) => chalk.dim(url),
    code: (text) => chalk.hex("#E5C07B")(text),
    codeBlock: (line) => chalk.hex("#ABB2BF")(line),
    codeBlockBorder: chalk.hex("#5C6370")("│"),
    quote: (text) => chalk.italic(chalk.hex("#5C6370")(text)),
    quoteBorder: chalk.hex("#5C6370")("▍"),
    hr: chalk.hex("#5C6370")("─".repeat(Math.min(width, 60))),
    listBullet: chalk.hex("#E5C07B")("•"),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    highlightCode: (code, lang) => {
      if (!lang || !supportsLanguage(lang)) return code.split("\n");
      try {
        const highlighted = highlight(code, {
          language: lang,
          ignoreIllegals: true,
        });
        return highlighted.split("\n");
      } catch {
        return code.split("\n");
      }
    },
    codeBlockIndent: "  ",
  };
}

// ─── Token Renderer ──────────────────────────────────────────────────────────

function renderInlineTokens(tokens: Token[], theme: MarkdownTheme): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "strong": {
          const t = token as Tokens.Strong;
          return theme.bold(renderInlineTokens(t.tokens ?? [], theme));
        }
        case "em": {
          const t = token as Tokens.Em;
          return theme.italic(renderInlineTokens(t.tokens ?? [], theme));
        }
        case "codespan": {
          const t = token as Tokens.Codespan;
          return theme.code(t.text);
        }
        case "link": {
          const t = token as Tokens.Link;
          const linkText = renderInlineTokens(t.tokens ?? [], theme);
          return `${theme.link(linkText)} (${theme.linkUrl(t.href)})`;
        }
        case "del": {
          const t = token as Tokens.Del;
          return theme.strikethrough(renderInlineTokens(t.tokens ?? [], theme));
        }
        case "br":
          return "\n";
        case "escape": {
          const t = token as Tokens.Escape;
          return t.text;
        }
        case "text": {
          const t = token as Tokens.Text;
          if (t.tokens && t.tokens.length > 0) {
            return renderInlineTokens(t.tokens, theme);
          }
          return chalk.hex("#ABB2BF")(t.text);
        }
        default: {
          const t = token as { text?: string; raw?: string };
          return t.text ?? t.raw ?? "";
        }
      }
    })
    .join("");
}

function appendWrappedListLines(
  lines: string[],
  content: string,
  firstPrefix: string,
  continuationPrefix: string,
  width: number,
): void {
  const contentLines = content.length > 0 ? content.split("\n") : [""];

  contentLines.forEach((contentLine, contentLineIndex) => {
    const prefix = contentLineIndex === 0 ? firstPrefix : continuationPrefix;
    const wrapped = wrapTextToWidth(
      contentLine.trimEnd(),
      Math.max(width - visibleLength(prefix), 10),
    );

    wrapped.forEach((wrappedLine, wrappedLineIndex) => {
      lines.push(
        `${wrappedLineIndex === 0 ? prefix : continuationPrefix}${wrappedLine}`,
      );
    });
  });
}

function renderList(
  token: Tokens.List,
  theme: MarkdownTheme,
  width: number,
): string {
  const lines: string[] = [];

  token.items.forEach((item, i) => {
    const bullet = token.ordered
      ? chalk.hex("#E5C07B")(`${(token.start || 1) + i}.`)
      : theme.listBullet;

    const firstPrefix = `${bullet} `;
    const continuationPrefix = " ".repeat(visibleLength(firstPrefix));
    let renderedItemContent = false;

    for (const t of item.tokens) {
      if (t.type === "text") {
        const textToken = t as Tokens.Text;
        const text =
          textToken.tokens && textToken.tokens.length > 0
            ? renderInlineTokens(textToken.tokens, theme)
            : chalk.hex("#ABB2BF")(textToken.text);

        appendWrappedListLines(
          lines,
          text,
          renderedItemContent ? continuationPrefix : firstPrefix,
          continuationPrefix,
          width,
        );
        renderedItemContent = true;
      } else if (t.type === "list") {
        if (!renderedItemContent) {
          lines.push(firstPrefix.trimEnd());
          renderedItemContent = true;
        }

        const nestedWidth = Math.max(
          width - visibleLength(continuationPrefix),
          10,
        );
        const nested = renderList(t as Tokens.List, theme, nestedWidth);
        for (const nestedLine of nested.split("\n")) {
          lines.push(`${continuationPrefix}${nestedLine}`);
        }
      } else {
        appendWrappedListLines(
          lines,
          renderToken(t, theme, width - visibleLength(continuationPrefix)),
          renderedItemContent ? continuationPrefix : firstPrefix,
          continuationPrefix,
          width,
        );
        renderedItemContent = true;
      }
    }

    if (!renderedItemContent) {
      lines.push(firstPrefix.trimEnd());
    }
  });

  return lines.join("\n");
}

function renderTable(
  token: Tokens.Table,
  theme: MarkdownTheme,
  _width: number,
): string {
  const cols = token.header.length;
  const colWidths: number[] = new Array(cols).fill(3);

  const headerTexts = token.header.map((cell) =>
    renderInlineTokens(cell.tokens, theme),
  );
  headerTexts.forEach((text, i) => {
    colWidths[i] = Math.max(colWidths[i], visibleLength(text));
  });

  const bodyTexts = token.rows.map((row) =>
    row.map((cell) => renderInlineTokens(cell.tokens, theme)),
  );
  bodyTexts.forEach((row) => {
    row.forEach((text, i) => {
      if (i < cols) colWidths[i] = Math.max(colWidths[i], visibleLength(text));
    });
  });

  const pad = (text: string, targetWidth: number): string =>
    text + " ".repeat(Math.max(0, targetWidth - visibleLength(text)));

  const renderRow = (cells: string[]): string =>
    "| " + cells.map((text, i) => pad(text, colWidths[i])).join(" | ") + " |";

  const separator =
    "|" + colWidths.map((w) => "-".repeat(w + 2)).join("|") + "|";

  return [renderRow(headerTexts), separator, ...bodyTexts.map(renderRow)].join(
    "\n",
  );
}

function renderToken(
  token: Token,
  theme: MarkdownTheme,
  width: number,
): string {
  switch (token.type) {
    case "heading": {
      const t = token as Tokens.Heading;
      const text = renderInlineTokens(t.tokens ?? [], theme);
      return theme.heading(text, t.depth);
    }
    case "paragraph": {
      const t = token as Tokens.Paragraph;
      const text =
        t.tokens && t.tokens.length > 0
          ? renderInlineTokens(t.tokens, theme)
          : chalk.hex("#ABB2BF")(t.text);
      return text
        .split("\n")
        .flatMap((line) => wrapTextToWidth(line, width))
        .join("\n");
    }
    case "code": {
      const t = token as Tokens.Code;
      const lines = theme.highlightCode(t.text, t.lang ?? undefined);
      return lines
        .map(
          (line) => `${theme.codeBlockBorder}${theme.codeBlockIndent}${line}`,
        )
        .join("\n");
    }
    case "blockquote": {
      const t = token as Tokens.Blockquote;
      const inner = t.tokens
        .map((tok) => renderToken(tok, theme, width - 2))
        .join("\n");
      return inner
        .split("\n")
        .map((line) => `${theme.quoteBorder} ${theme.quote(line)}`)
        .join("\n");
    }
    case "list":
      return renderList(token as Tokens.List, theme, width);
    case "table":
      return renderTable(token as Tokens.Table, theme, width);
    case "hr":
      return theme.hr;
    case "space":
      return "";
    default: {
      const t = token as { text?: string; raw?: string };
      return t.text ?? t.raw ?? "";
    }
  }
}

export function renderMarkdown(
  text: string,
  theme: MarkdownTheme,
  width: number,
): string {
  const tokens = marked.lexer(text);
  return tokens
    .map((token) => renderToken(token, theme, width))
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * Interface for streamer objects that handle markdown rendering
 */
export interface Streamer {
  push(token: string): void;
  flush(): void;
  finish(): void;
}

/**
 * Strip trailing ANSI SGR codes and whitespace from a string.
 * The custom renderer appends reset codes + newlines after each block,
 * and these shift rightward as content grows. Stripping them gives
 * a stable prefix we can diff against.
 */
function stripTrailingAnsi(str: string): string {
  return str.replace(/(\x1b\[\d*(;\d+)*m|\s)*$/, "");
}

function stripAnsiSgr(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function countTerminalRows(str: string, columns: number): number {
  const safeColumns = Math.max(columns, 1);
  const lines = stripAnsiSgr(str).split("\n");

  return lines.reduce((count, line) => {
    const lineLength = line.length;
    const rowsForLine =
      lineLength === 0 ? 1 : Math.ceil(lineLength / safeColumns);
    return count + rowsForLine;
  }, 0);
}

/**
 * MarkdownStreamer buffers streaming tokens and renders them as markdown
 * using a custom token-based renderer with append-only delta rendering.
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
  private readonly unwatchResize: () => void;
  private theme: MarkdownTheme;
  private width: number;
  private disposed = false;

  constructor(stderr: NodeJS.WriteStream, renderIntervalMs: number = 80) {
    this.stderr = stderr;
    this.renderIntervalMs = renderIntervalMs;
    this.width = this.resolveRenderWidth();
    this.theme = defaultTheme(this.width);
    this.unwatchResize = watchTerminalResize(this.stderr, () => {
      this.render();
    });
  }

  push(token: string): void {
    if (this.disposed) {
      return;
    }

    this.buffer += sanitizeSurrogates(token);
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
    this.dispose();
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
    this.throttleTimerId.unref();
  }

  /**
   * Delta render. Parses the full buffer, strips trailing ANSI resets,
   * and writes only the new content since the last render. On divergence
   * (inline formatting change), rewinds to the last newline boundary
   * and rewrites from there.
   */
  private render(): void {
    if (this.disposed || this.buffer.length === 0) {
      return;
    }

    this.lastRenderTime = Date.now();
    this.refreshRenderGeometry();

    const parsed = this.parseBufferSafely(this.buffer);
    this.writeRenderedOutput(parsed, false);
  }

  /**
   * Final render for flush/finish: writes the complete parsed output
   * including trailing ANSI resets and newlines that were stripped
   * during streaming renders.
   */
  private renderFinal(): void {
    if (this.disposed || this.buffer.length === 0) {
      return;
    }

    this.lastRenderTime = Date.now();
    this.refreshRenderGeometry();

    const parsed = this.parseBufferSafely(this.buffer);
    this.writeRenderedOutput(parsed, true);
  }

  private writeRenderedOutput(parsed: string, includeTrailing: boolean): void {
    const stripped = stripTrailingAnsi(parsed);

    if (!stripped.startsWith(this.committedOutput)) {
      this.rewriteFromDivergence(stripped);
    } else {
      const delta = stripped.substring(this.committedOutput.length);
      if (delta.length > 0) {
        this.stderr.write(delta);
        this.committedOutput = stripped;
      }
    }

    if (includeTrailing) {
      // Write trailing ANSI resets and newlines that were stripped during streaming.
      const trailing = parsed.substring(stripped.length);
      if (trailing.length > 0) {
        this.stderr.write(trailing);
      }
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

    const committedSuffix = this.committedOutput.substring(rewindTo + 1);
    const rowsToRewrite = countTerminalRows(
      committedSuffix,
      this.resolveTerminalColumns(),
    );
    const linesUp = Math.max(0, rowsToRewrite - 1);

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

  private dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.unwatchResize();
  }

  private resolveRenderWidth(): number {
    return Math.max((this.stderr.columns ?? 80) - 1, 40);
  }

  private resolveTerminalColumns(): number {
    return Math.max(this.stderr.columns ?? 80, 40);
  }

  private refreshRenderGeometry(): void {
    const nextWidth = this.resolveRenderWidth();
    if (nextWidth !== this.width) {
      this.width = nextWidth;
      this.theme = defaultTheme(this.width);
    }
  }

  private parseBufferSafely(buffer: string): string {
    try {
      const result = renderMarkdown(buffer, this.theme, this.width);
      return typeof result === "string" ? result : buffer;
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
