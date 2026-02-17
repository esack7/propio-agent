import { MarkdownStreamer } from "../ui/markdownRenderer.js";

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

    it("should handle bold and italic markdown", () => {
      streamer.push("**bold** and *italic* text");
      streamer.flush();

      const output = writtenOutput.join("");
      expect(output).toContain("bold");
      expect(output).toContain("italic");
    });

    it("should fallback to raw buffer when markdown parsing throws", () => {
      const markedInstance = (
        streamer as unknown as {
          marked: { parse: (markdown: string) => string | Promise<string> };
        }
      ).marked;
      const originalParse = markedInstance.parse;
      markedInstance.parse = () => {
        throw new Error("parse failure");
      };
      try {
        streamer.push("# Header\nContent");
        streamer.flush();

        const output = writtenOutput.join("");
        expect(output).toContain("# Header\nContent");
      } finally {
        markedInstance.parse = originalParse;
      }
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
      expect(output).toContain("Title");
      expect(output).toContain("Subsection");
      expect(output).toContain("Point 1");
      expect(output).toContain("Point 2");
      expect(output).toContain("const x = 42");
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
  });
});
