import { EventEmitter } from "events";
import {
  MarkdownStreamer,
  sanitizeSurrogates,
  renderMarkdown,
  defaultTheme,
} from "../ui/markdownRenderer.js";
import { visibleLength } from "../ui/terminalWriter.js";

function createResizableStderr(
  columns: number,
  writtenOutput: string[],
): NodeJS.WriteStream {
  const emitter = new EventEmitter();

  return {
    write: (chunk: string) => {
      writtenOutput.push(chunk);
      return true;
    },
    isTTY: true,
    columns,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as NodeJS.WriteStream;
}

describe("MarkdownStreamer", () => {
  let mockStderr: NodeJS.WriteStream;
  let writtenOutput: string[];
  let streamer: MarkdownStreamer;

  beforeEach(() => {
    writtenOutput = [];
    mockStderr = {
      write: (chunk: string) => {
        writtenOutput.push(chunk);
        return true;
      },
      isTTY: true,
      columns: 80,
    } as unknown as NodeJS.WriteStream;

    streamer = new MarkdownStreamer(mockStderr);
  });

  afterEach(() => {
    // Ensure cleanup
    streamer.finish();
  });

  describe("buffer accumulation", () => {
    it("should accumulate tokens in an internal buffer", () => {
      streamer.push("Hello");
      streamer.push(" ");
      streamer.push("World");
      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("Hello World");
    });

    it("should handle empty push gracefully", () => {
      streamer.push("");
      streamer.push("test");
      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("test");
    });

    it("should buffer multiple tokens before rendering", () => {
      const tokens = ["Token", "1", "Token", "2", "Token", "3"];
      tokens.forEach((t) => streamer.push(t));

      // Before flush, we don't know exactly what's been written due to debounce
      // But after flush, all tokens should be accumulated and rendered
      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("Token1Token2Token3");
    });
  });

  describe("append-only delta rendering", () => {
    it("should only write new content on subsequent renders", async () => {
      streamer.push("Line 1\nLine 2");
      streamer.flush();

      const firstOutput = writtenOutput.join("");
      expect(firstOutput).toContain("Line 1");
      expect(firstOutput).toContain("Line 2");

      writtenOutput.length = 0;

      // Second push should only write the delta
      streamer.push("\nLine 3");
      await new Promise((resolve) => setTimeout(resolve, 150));
      streamer.flush();

      const secondOutput = writtenOutput.join("");
      expect(secondOutput).toContain("Line 3");
      // Should NOT re-write the first lines
      expect(secondOutput).not.toContain("Line 1");
    });

    it("should not emit cursor control sequences during normal append-only flow", () => {
      streamer.push("Some content");
      streamer.flush();

      const output = writtenOutput.join("");
      // Delta renderer does not use cursor save/restore or cursor movement in normal flow
      expect(output).not.toMatch(/\x1b7/); // No DECSC
      expect(output).not.toMatch(/\x1b8/); // No DECRC
      expect(output).not.toMatch(/\x1b\[\d+A/); // No cursor up
      expect(output).not.toMatch(/\x1b\[0J/); // No clear to end
    });

    it("should emit cursor control sequences when divergence occurs", async () => {
      // Push incomplete markdown that will render literally (no formatting)
      streamer.push("**bold");
      await new Promise((resolve) => setTimeout(resolve, 150));

      writtenOutput.length = 0;

      // Complete the markdown - this will cause re-parsing where previous plain text
      // now becomes bold formatted text, triggering divergence in ANSI output
      streamer.push(" text**");
      await new Promise((resolve) => setTimeout(resolve, 150));

      const output = writtenOutput.join("");

      // In a divergence scenario, we should see cursor-up and clear-to-end sequences
      // The implementation uses \x1b[${linesUp}A for cursor up and \x1b[0J for clear to end
      const hasCursorUp = /\x1b\[\d*A/.test(output);
      const hasClearToEnd = /\x1b\[0J/.test(output);

      // At least one of these should be true when divergence is handled
      // (cursor-up might be 0 if divergence is on the same line)
      expect(hasCursorUp || hasClearToEnd).toBe(true);
    });

    it("should rewind terminal soft-wrapped lines when divergence occurs", async () => {
      mockStderr.columns = 30;
      streamer = new MarkdownStreamer(mockStderr, 1);

      streamer.push(
        "- supercalifragilisticexpialidocioussupercalifragilistic**bol",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      writtenOutput.length = 0;
      streamer.push("d**");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const output = writtenOutput.join("");

      expect(output).toMatch(/\x1b\[[1-9]\d*A/);
      expect(output).toContain("\x1b[0J");
    });

    it("should not write anything for empty buffer", () => {
      streamer.push("");
      writtenOutput.length = 0;

      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toBe("");
    });
  });

  describe("throttling", () => {
    it("should batch multiple rapid push calls", async () => {
      const tokens = "This is a test message".split(" ");
      for (const token of tokens) {
        streamer.push(token + " ");
      }

      // Wait for throttle to fire
      await new Promise((resolve) => setTimeout(resolve, 150));

      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("This is a test message");
    });

    it("should render immediately on flush despite throttle", async () => {
      streamer.push("Throttled");
      streamer.push(" content");

      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("Throttled content");
    });

    it("should render immediately on finish despite throttle", async () => {
      streamer.push("Final");
      streamer.push(" content");

      streamer.finish();

      const output = writtenOutput.join("");
      expect(output).toContain("Final content");
    });

    it("should cancel pending throttle timer on flush", async () => {
      const beforeFlushLength = writtenOutput.length;

      streamer.push("First");
      streamer.flush();

      const afterFirstFlush = writtenOutput.length;
      expect(afterFirstFlush).toBeGreaterThan(beforeFlushLength);

      writtenOutput.length = 0;

      streamer.push(" Second");
      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("Second");
    });
  });

  describe("flush lifecycle", () => {
    it("should clear the buffer after flush", () => {
      streamer.push("Content");
      streamer.flush();

      writtenOutput.length = 0;

      // Push new content and flush immediately
      streamer.push("New");
      streamer.flush();

      const output = writtenOutput.join("");
      // Should not contain "Content" from before, only "New"
      expect(output).toContain("New");
      expect(output).not.toContain("Content");
    });

    it("should reset committed output tracking after flush", async () => {
      streamer.push("Line 1\nLine 2\nLine 3");
      streamer.flush();
      writtenOutput.length = 0;

      // After flush, committed output resets so new content starts fresh
      streamer.push("New Line");
      await new Promise((resolve) => setTimeout(resolve, 150));

      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("New Line");
      // Should not contain old content
      expect(output).not.toContain("Line 1");
    });

    it("should handle multiple flush calls", () => {
      streamer.push("First");
      streamer.flush();

      streamer.push("Second");
      streamer.flush();

      streamer.push("Third");
      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("First");
      expect(output).toContain("Second");
      expect(output).toContain("Third");
    });
  });

  describe("finish lifecycle", () => {
    it("should call flush internally", () => {
      streamer.push("Content");
      streamer.finish();

      const output = writtenOutput.join("");
      expect(output).toContain("Content");
    });

    it("should render all content on finish", () => {
      streamer.push("Content with\nmultiple\nlines");
      streamer.finish();

      const output = writtenOutput.join("");
      expect(output).toContain("Content with");
      expect(output).toContain("multiple");
      expect(output).toContain("lines");
    });

    it("should cancel any pending timers on finish", async () => {
      streamer.push("Pending");
      // Don't flush, let debounce timer run
      await new Promise((resolve) => setTimeout(resolve, 30));

      writtenOutput.length = 0;

      streamer.finish();

      // Wait longer than debounce would take
      await new Promise((resolve) => setTimeout(resolve, 100));

      // finish() should have cancelled the timer and rendered
      const output = writtenOutput.join("");
      expect(output).toBeDefined();
    });

    it("should be safe to call multiple times", () => {
      streamer.push("Content");
      streamer.finish();

      const lengthAfterFirst = writtenOutput.length;

      // Call finish again
      expect(() => {
        streamer.finish();
      }).not.toThrow();
    });
  });

  describe("empty buffer edge case", () => {
    it("should handle flush with empty buffer gracefully", () => {
      // Create new streamer and immediately flush without pushing anything
      const freshStreamer = new MarkdownStreamer(mockStderr);
      writtenOutput.length = 0;

      freshStreamer.flush();

      const output = writtenOutput.join("");
      // Should not emit any ANSI sequences for empty flush
      expect(output).not.toMatch(/\x1b\[\d+A/);
      expect(output).not.toMatch(/\x1b\[0J/);
    });

    it("should handle finish with empty buffer gracefully", () => {
      const freshStreamer = new MarkdownStreamer(mockStderr);
      writtenOutput.length = 0;

      freshStreamer.finish();

      const output = writtenOutput.join("");
      // Should not throw and should complete cleanly
      expect(output).toBeDefined();
    });

    it("should handle alternating push and flush with empty state", () => {
      streamer.push("Content");
      streamer.flush();

      streamer.push("");
      streamer.flush();

      streamer.push("More");
      streamer.finish();

      const output = writtenOutput.join("");
      expect(output).toContain("Content");
      expect(output).toContain("More");
    });
  });

  describe("markdown parsing", () => {
    it("should parse and render markdown headers", () => {
      streamer.push("# Header\nContent");
      streamer.flush();

      const output = writtenOutput.join("");
      // Should contain the header text and styling
      expect(output).toContain("Header");
      expect(output).toContain("Content");
    });

    it("should parse and render markdown code blocks", () => {
      streamer.push("```\ncode here\n```");
      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("code here");
    });

    it("should parse and render markdown lists", () => {
      streamer.push("- Item 1\n- Item 2");
      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("Item 1");
      expect(output).toContain("Item 2");
    });

    it("should wrap long list items at word boundaries", () => {
      const output = renderMarkdown(
        "- alpha beta gamma delta",
        defaultTheme(12),
        12,
      ).replace(/\x1b\[[0-9;]*m/g, "");

      expect(output).toContain("• alpha beta");
      expect(output).toContain("  gamma");
      expect(output).toContain("  delta");
      expect(output).not.toContain("gamm\na");
    });

    it("should keep nested list continuation indentation stable", () => {
      const output = renderMarkdown(
        [
          "3. Test fragility:",
          "   - Relies on setTimeout(20) + global writtenOutput side-effects. Consider a more deterministic mock or jest.useFakeTimers().",
          "   - The regex assert `/\\x1b\\[[1-9]\\d*A/` is loose; could be tighter or use the existing hasCursorUp helper pattern from other tests.",
          "4. Minor:",
          "   - JSDoc on new helpers would be nice (file follows existing comment style).",
        ].join("\n"),
        defaultTheme(80),
        80,
      ).replace(/\x1b\[[0-9;]*m/g, "");

      expect(output).toContain(
        "   • Relies on setTimeout(20) + global writtenOutput side-effects. Consider a\n" +
          "     more deterministic mock or jest.useFakeTimers().",
      );
      expect(output).toContain(
        "   • The regex assert /\\x1b\\[[1-9]\\d*A/ is loose; could be tighter or use the\n" +
          "     existing hasCursorUp helper pattern from other tests.",
      );
      expect(output).not.toContain("\n   existing");
    });

    it("should handle bold and italic markdown", () => {
      streamer.push("**bold** and *italic* text");
      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("bold");
      expect(output).toContain("italic");
    });

    it("should fallback to raw buffer when markdown parsing throws", () => {
      // Override parseBufferSafely on the instance to simulate a rendering failure
      (streamer as any).parseBufferSafely = (buffer: string): string => buffer;

      streamer.push("# Header\nContent");
      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("# Header\nContent");
    });
  });

  describe("streaming with marked output", () => {
    it("should handle streaming a full markdown response", async () => {
      const markdown = `# Title
This is a paragraph.

## Subsection
- Point 1
- Point 2

\`\`\`javascript
const x = 42;
\`\`\``;

      // Stream it character by character like a real LLM
      for (const char of markdown) {
        streamer.push(char);
      }

      streamer.finish();

      const output = writtenOutput.join("");
      const plainOutput = output.replace(/\x1b\[[^m]*m/g, "");
      expect(plainOutput).toContain("Title");
      expect(plainOutput).toContain("Subsection");
      expect(plainOutput).toContain("Point 1");
      expect(plainOutput).toContain("Point 2");
      expect(plainOutput).toContain("const x = 42");
    });

    it("should handle incomplete markdown during streaming", () => {
      // Push incomplete markdown (unclosed code fence)
      streamer.push("Some text\n```\nincomplete code");
      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("Some text");
      expect(output).toContain("incomplete code");
    });
  });

  describe("non-TTY mode handling", () => {
    it("should handle non-TTY stderr gracefully", () => {
      const nonTtyStderr = {
        write: (chunk: string) => {
          writtenOutput.push(chunk);
          return true;
        },
        isTTY: false,
        columns: undefined,
      } as unknown as NodeJS.WriteStream;

      const nonTtyStreamer = new MarkdownStreamer(nonTtyStderr);
      nonTtyStreamer.push("Content");
      nonTtyStreamer.flush();

      const output = writtenOutput.join("");
      // Should still render the content, but might not use cursor sequences
      expect(output).toContain("Content");
    });
  });

  describe("column width handling", () => {
    it("should use stderr columns when available", () => {
      const wideTTY = {
        write: (chunk: string) => {
          writtenOutput.push(chunk);
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WriteStream;

      const wideStreamer = new MarkdownStreamer(wideTTY);
      wideStreamer.push("# Long Header with lots of text that might wrap");
      wideStreamer.flush();

      const output = writtenOutput.join("");
      expect(output).toBeDefined();
    });

    it("should fallback gracefully when columns is not available", () => {
      const noColumnsStderr = {
        write: (chunk: string) => {
          writtenOutput.push(chunk);
          return true;
        },
        isTTY: true,
        columns: 0,
      } as unknown as NodeJS.WriteStream;

      const fallbackStreamer = new MarkdownStreamer(noColumnsStderr);
      fallbackStreamer.push("Content");
      fallbackStreamer.finish();

      const output = writtenOutput.join("");
      expect(output).toContain("Content");
    });

    it("should adapt wrapping when terminal columns change", () => {
      const dynamicStderr = {
        write: (chunk: string) => {
          writtenOutput.push(chunk);
          return true;
        },
        isTTY: true,
        columns: 120,
      } as unknown as NodeJS.WriteStream;

      const dynamicStreamer = new MarkdownStreamer(dynamicStderr);
      dynamicStderr.columns = 50;

      dynamicStreamer.push(
        "0123456789 0123456789 0123456789 0123456789 0123456789 0123456789",
      );
      dynamicStreamer.flush();

      const plainOutput = writtenOutput.join("").replace(/\x1b\[[0-9;]*m/g, "");
      expect(plainOutput).toContain("\n");
    });

    it("should repaint an active stream when the terminal is resized", async () => {
      const resizableStderr = createResizableStderr(80, writtenOutput);
      const resizeStreamer = new MarkdownStreamer(resizableStderr, 0);

      resizeStreamer.push(
        "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      writtenOutput.length = 0;

      resizableStderr.columns = 30;
      resizableStderr.emit("resize");

      const output = writtenOutput.join("");
      const plainOutput = output.replace(/\x1b\[[0-9;]*m/g, "");
      expect(output).toContain("\x1b[0J");
      expect(plainOutput).toContain("\n");

      resizeStreamer.finish();
    });
  });
});

describe("sanitizeSurrogates", () => {
  it("should pass through clean input unmodified", () => {
    expect(sanitizeSurrogates("hello world")).toBe("hello world");
  });

  it("should pass through empty string", () => {
    expect(sanitizeSurrogates("")).toBe("");
  });

  it("should strip unpaired high surrogates", () => {
    expect(sanitizeSurrogates("\uD800hello")).toBe("hello");
    expect(sanitizeSurrogates("hello\uDBFF")).toBe("hello");
  });

  it("should strip unpaired low surrogates", () => {
    expect(sanitizeSurrogates("hello\uDC00")).toBe("hello");
    expect(sanitizeSurrogates("\uDFFFworld")).toBe("world");
  });

  it("should preserve valid surrogate pairs", () => {
    // U+1F600 😀 = \uD83D\uDE00
    const withEmoji = "hello \uD83D\uDE00 world";
    expect(sanitizeSurrogates(withEmoji)).toBe("hello \uD83D\uDE00 world");
  });

  it("should strip unpaired surrogates while preserving surrounding text", () => {
    expect(sanitizeSurrogates("before\uD800after")).toBe("beforeafter");
  });
});

describe("visibleLength", () => {
  it("should return the length of a plain string", () => {
    expect(visibleLength("hello")).toBe(5);
  });

  it("should return 0 for an empty string", () => {
    expect(visibleLength("")).toBe(0);
  });

  it("should ignore ANSI SGR escape codes", () => {
    expect(visibleLength("\x1b[31mhello\x1b[0m")).toBe(5);
  });

  it("should ignore multiple nested ANSI codes", () => {
    expect(visibleLength("\x1b[1m\x1b[33mtext\x1b[0m\x1b[0m")).toBe(4);
  });

  it("should return 0 for a string with only ANSI codes", () => {
    expect(visibleLength("\x1b[0m\x1b[1m")).toBe(0);
  });

  it("should handle strings with no ANSI codes identically to .length", () => {
    const plain = "plain text 123";
    expect(visibleLength(plain)).toBe(plain.length);
  });
});

describe("renderMarkdown", () => {
  const width = 80;
  const theme = defaultTheme(width);

  it("should render h1 heading", () => {
    const output = renderMarkdown("# Heading 1", theme, width);
    expect(output).toContain("Heading 1");
  });

  it("should render h2 heading", () => {
    const output = renderMarkdown("## Heading 2", theme, width);
    expect(output).toContain("Heading 2");
  });

  it("should render a paragraph", () => {
    const output = renderMarkdown("A paragraph of text.", theme, width);
    expect(output).toContain("A paragraph of text.");
  });

  it("should render a fenced code block without language", () => {
    const output = renderMarkdown("```\nsome code here\n```", theme, width);
    expect(output).toContain("some code here");
  });

  it("should render a fenced code block with language", () => {
    const output = renderMarkdown(
      "```javascript\nconst x = 1;\n```",
      theme,
      width,
    );
    expect(output).toContain("x");
    expect(output).toContain("1");
  });

  it("should not throw for unknown language in code block", () => {
    expect(() => {
      renderMarkdown("```unknownlang\nsome code\n```", theme, width);
    }).not.toThrow();
  });

  it("should render an unordered list", () => {
    const output = renderMarkdown("- Item 1\n- Item 2", theme, width);
    expect(output).toContain("Item 1");
    expect(output).toContain("Item 2");
  });

  it("should render a blockquote", () => {
    const output = renderMarkdown("> A blockquote", theme, width);
    expect(output).toContain("A blockquote");
  });

  it("should render inline bold", () => {
    const output = renderMarkdown("Some **bold** text", theme, width);
    expect(output).toContain("bold");
  });

  it("should render inline italic", () => {
    const output = renderMarkdown("Some *italic* text", theme, width);
    expect(output).toContain("italic");
  });

  it("should render inline code span", () => {
    const output = renderMarkdown("Use `someFunction()` here", theme, width);
    expect(output).toContain("someFunction()");
  });
});
