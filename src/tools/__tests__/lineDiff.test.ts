import { describe, expect, it } from "@jest/globals";
import { utf8Length, type DiffHunk, type DiffLine } from "../display.js";
import { diffLines, splitLines } from "../lineDiff.js";

/** The line as it was in its text, with its line break if it had one. */
const asWritten = (line: DiffLine) =>
  line.noNewline ? line.text : `${line.text}\n`;

/** The new lines that the hunks say the old lines become. */
function applyHunks(oldLines: readonly string[], hunks: readonly DiffHunk[]) {
  const result: string[] = [];
  let position = 0;
  for (const hunk of hunks) {
    const removes = hunk.lines.some((line) => line.op !== "+");
    const start = removes ? hunk.oldStart - 1 : hunk.oldStart;
    result.push(...oldLines.slice(position, start));
    position = start;
    for (const line of hunk.lines) {
      if (line.op === "+") {
        result.push(asWritten(line));
        continue;
      }
      expect(oldLines[position]).toBe(asWritten(line));
      if (line.op === " ") result.push(asWritten(line));
      position++;
    }
  }
  result.push(...oldLines.slice(position));
  return result;
}

/** A small deterministic generator, so a failure can be reproduced. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function expectRoundTrip(oldText: string, newText: string, context = 3) {
  const diff = diffLines(oldText, newText, { context });
  expect(diff.truncated).toBe(false);
  expect(applyHunks(splitLines(oldText), diff.hunks)).toEqual(
    splitLines(newText),
  );
  const shown = diff.hunks.flatMap((hunk) => hunk.lines);
  expect(shown.filter((line) => line.op === "+")).toHaveLength(diff.added);
  expect(shown.filter((line) => line.op === "-")).toHaveLength(diff.removed);
  return diff;
}

describe("diffLines", () => {
  it("reproduces the new text from the old for random line edits", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const words = ["a", "b", "c", "d", "", "  x", "y\r"];
      const pick = () => words[Math.floor(next() * words.length)];
      const oldLines = Array.from({ length: Math.floor(next() * 40) }, pick);
      const newLines = [...oldLines];
      for (let edit = Math.floor(next() * 8); edit > 0; edit--) {
        const at = Math.floor(next() * (newLines.length + 1));
        const kind = next();
        if (kind < 0.4) newLines.splice(at, 0, pick());
        else if (kind < 0.8) newLines.splice(at, 1);
        else newLines.splice(at, 1, pick(), pick());
      }
      const ending = () => (next() < 0.5 ? "\n" : "");
      expectRoundTrip(
        oldLines.join("\n") + (oldLines.length > 0 ? ending() : ""),
        newLines.join("\n") + (newLines.length > 0 ? ending() : ""),
        Math.floor(next() * 4),
      );
    }
  });

  it("shows a change with three lines of context and 1-based starts", () => {
    const oldText = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
    const diff = expectRoundTrip(oldText, oldText.replace("5", "five"));
    expect(diff).toMatchObject({ added: 1, removed: 1 });
    expect(diff.hunks).toEqual([
      {
        oldStart: 2,
        newStart: 2,
        lines: [
          { op: " ", text: "2" },
          { op: " ", text: "3" },
          { op: " ", text: "4" },
          { op: "-", text: "5" },
          { op: "+", text: "five" },
          { op: " ", text: "6" },
          { op: " ", text: "7" },
          { op: " ", text: "8" },
        ],
      },
    ]);
  });

  it("handles empty sides, identical texts, and a missing final newline", () => {
    expect(expectRoundTrip("", "a\nb\n")).toMatchObject({
      added: 2,
      removed: 0,
      hunks: [{ oldStart: 0, newStart: 1 }],
    });
    expect(expectRoundTrip("a\nb\n", "")).toMatchObject({
      added: 0,
      removed: 2,
      hunks: [{ oldStart: 1, newStart: 0 }],
    });
    expect(diffLines("same\n", "same\n").hunks).toEqual([]);
    expectRoundTrip("a\nb", "a\nc");
  });

  it("shows a final line gaining or losing its line break", () => {
    const gained = expectRoundTrip("a\nb", "a\nb\n");
    expect(gained).toMatchObject({ added: 1, removed: 1 });
    expect(gained.hunks[0].lines).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b", noNewline: true },
      { op: "+", text: "b" },
    ]);
    const lost = expectRoundTrip("a\nb\n", "a\nb");
    expect(lost.hunks[0].lines.slice(1)).toEqual([
      { op: "-", text: "b" },
      { op: "+", text: "b", noNewline: true },
    ]);
  });

  it("keeps carriage returns in the line they end", () => {
    const diff = expectRoundTrip("a\r\nb\r\n", "a\r\nc\r\n");
    expect(diff.hunks[0].lines).toContainEqual({ op: "+", text: "c\r" });
  });

  it("separates distant changes into hunks and merges near ones", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const changed = [...lines];
    changed[2] = "first";
    changed[30] = "second";
    expect(
      expectRoundTrip(lines.join("\n"), changed.join("\n")).hunks,
    ).toHaveLength(2);
    changed[6] = "near the first";
    expect(
      expectRoundTrip(lines.join("\n"), changed.join("\n")).hunks,
    ).toHaveLength(2);
  });

  it("stops at the line limit and still counts the whole change", () => {
    const oldText = Array.from({ length: 500 }, (_, i) => `old ${i}`).join(
      "\n",
    );
    const newText = Array.from({ length: 500 }, (_, i) => `new ${i}`).join(
      "\n",
    );
    const diff = diffLines(oldText, newText, { maxLines: 50 });
    expect(diff.truncated).toBe(true);
    expect(diff.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(50);
    expect(diff).toMatchObject({ added: 500, removed: 500 });
  });

  it("stops at the byte limit, cutting a long line, and says so", () => {
    const long = "é".repeat(1_000_000);
    const diff = diffLines("", `${long}\nshort\n`, { maxBytes: 1000 });
    expect(diff.truncated).toBe(true);
    expect(diff).toMatchObject({ added: 2, removed: 0 });
    const lines = diff.hunks.flatMap((hunk) => hunk.lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ op: "+", truncated: true });
    expect(utf8Length(lines[0].text)).toBe(1000);

    // Several lines share one budget.
    const many = Array.from({ length: 100 }, () => "x".repeat(50)).join("\n");
    const shared = diffLines("", many, { maxBytes: 1000 });
    expect(shared.truncated).toBe(true);
    const bytes = shared.hunks
      .flatMap((hunk) => hunk.lines)
      .reduce((sum, line) => sum + utf8Length(line.text), 0);
    expect(bytes).toBeLessThanOrEqual(1000);
  });

  it("shows the middle as one replacement once the deadline has passed", () => {
    let clock = 0;
    const now = () => ++clock;
    const oldText = "keep\na\nb\nc\nkeep\n";
    const newText = "keep\nb\nc\nd\nkeep\n";
    const late = diffLines(oldText, newText, { deadline: { at: 0, now } });
    expect(clock).toBeGreaterThan(0);
    expect(late).toMatchObject({ added: 3, removed: 3 });
    expect(applyHunks(splitLines(oldText), late.hunks)).toEqual(
      splitLines(newText),
    );
    // With time to spare, the smallest diff.
    const early = diffLines(oldText, newText, {
      deadline: { at: Number.POSITIVE_INFINITY, now },
    });
    expect(early).toMatchObject({ added: 1, removed: 1 });
  });

  it("falls back to one replacement when two large texts share nothing", () => {
    const oldText = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join(
      "\n",
    );
    const newText = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join(
      "\n",
    );
    const started = Date.now();
    const diff = expectRoundTrip(
      `head\n${oldText}\ntail`,
      `head\n${newText}\ntail`,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(diff).toMatchObject({ added: 3000, removed: 3000 });
  });
});
