import {
  buildTextPastePill,
  countPasteLines,
  shouldCollapsePaste,
} from "../collapsePaste.js";
import { PASTE_THRESHOLD } from "../constants.js";

describe("countPasteLines", () => {
  it.each([
    ["a\nb", 2],
    ["a\nb\n", 2],
    ["a\n\nb", 3],
    ["", 0],
    ["\n", 1],
  ] as const)("counts %j as %i lines", (text, expected) => {
    expect(countPasteLines(text)).toBe(expected);
  });
});

describe("shouldCollapsePaste", () => {
  it("does not collapse under the character threshold with few lines", () => {
    expect(shouldCollapsePaste("a".repeat(PASTE_THRESHOLD), 24)).toBe(false);
  });

  it("collapses when text exceeds the character threshold", () => {
    expect(shouldCollapsePaste("a".repeat(PASTE_THRESHOLD + 1), 24)).toBe(true);
  });

  it("collapses when line count exceeds the terminal-derived cap", () => {
    expect(shouldCollapsePaste("a\nb\nc", 24)).toBe(true);
  });
});

describe("buildTextPastePill", () => {
  it("omits the line suffix for single-line pastes", () => {
    expect(buildTextPastePill(1, 1)).toBe("[Pasted text #1]");
  });

  it("uses M = lineCount - 1 in the pill suffix", () => {
    expect(buildTextPastePill(2, 3)).toBe("[Pasted text #2 +2 lines]");
  });
});
