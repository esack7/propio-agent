/** How many terminal cells text takes, ignoring ANSI styling. */

const ANSI_ESCAPE = "\\x1B\\[[0-?]*[ -/]*[@-~]";
const ANSI_ESCAPE_PATTERN = new RegExp(ANSI_ESCAPE, "g");
const ANSI_ESCAPE_SPLIT = new RegExp(`(${ANSI_ESCAPE})`);
const IS_ANSI_ESCAPE = new RegExp(`^${ANSI_ESCAPE}$`);
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_PRESENTATION = "️";

type CodePointRange = readonly [number, number];

const COMBINING_MARK_RANGES: readonly CodePointRange[] = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
];

const WIDE_CHARACTER_RANGES: readonly CodePointRange[] = [
  [0x1100, 0x115f],
  [0x2329, 0x2329],
  [0x232a, 0x232a],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function inCodePointRanges(
  codePoint: number,
  ranges: readonly CodePointRange[],
): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function isCombiningMark(codePoint: number): boolean {
  return inCodePointRanges(codePoint, COMBINING_MARK_RANGES);
}

function isWideCharacter(codePoint: number): boolean {
  return (
    codePoint !== 0x303f && inCodePointRanges(codePoint, WIDE_CHARACTER_RANGES)
  );
}

export function getDisplayWidth(text: string): number {
  let width = 0;
  for (const character of stripAnsi(text)) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }

    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      continue;
    }

    if (isCombiningMark(codePoint)) {
      continue;
    }

    width += isWideCharacter(codePoint) ? 2 : 1;
  }

  return width;
}

/**
 * The most cells a character may take. Terminals disagree about emoji, so
 * they count as wide, and an emoji-presentation selector counts as widening
 * the character before it. Text measured this way never takes more room on
 * screen than it was counted to need.
 */
function widestDisplayWidth(cluster: string): number {
  let width = 0;
  for (const character of cluster) {
    if (PICTOGRAPHIC.test(character)) width += 2;
    else if (character === EMOJI_PRESENTATION) width += 1;
    else width += getDisplayWidth(character);
  }
  return width;
}

const ZERO_WIDTH_JOINER = 0x200d;

/** Code points that belong to the character before them. */
function joinsPrevious(codePoint: number): boolean {
  return (
    isCombiningMark(codePoint) ||
    codePoint === ZERO_WIDTH_JOINER ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // variation selectors
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) || // skin tones
    codePoint === 0x20e3 || // keycap
    (codePoint >= 0xe0020 && codePoint <= 0xe007f) // tag sequences
  );
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

/**
 * Split text into the characters a reader sees, so that none is cut in
 * half: combining marks, emoji modifiers and joined emoji stay with what
 * they belong to, and flags stay paired.
 */
function graphemes(text: string): string[] {
  const clusters: string[] = [];
  let previous: number | undefined;
  let pairedFlag = false;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    const flagHalf: boolean =
      isRegionalIndicator(codePoint) &&
      previous !== undefined &&
      isRegionalIndicator(previous) &&
      !pairedFlag;
    const joins =
      clusters.length > 0 &&
      (joinsPrevious(codePoint) || previous === ZERO_WIDTH_JOINER || flagHalf);
    if (joins) clusters[clusters.length - 1] += character;
    else clusters.push(character);
    pairedFlag = flagHalf;
    previous = codePoint;
  }
  return clusters;
}

/** Styling sequences and whole characters, in order. */
function displayParts(text: string): string[] {
  const parts: string[] = [];
  for (const piece of text.split(ANSI_ESCAPE_SPLIT)) {
    if (piece === "") continue;
    if (IS_ANSI_ESCAPE.test(piece)) {
      parts.push(piece);
      continue;
    }
    parts.push(...graphemes(piece));
  }
  return parts;
}

/**
 * Keep the end of `text` within `width` cells, marking the cut with
 * `marker`. Characters are never split, and every styling sequence is kept
 * so the styles in force stay balanced.
 */
export function keepEndWithinDisplayWidth(
  text: string,
  width: number,
  marker = "…",
): string {
  const parts = displayParts(text);
  const widths = parts.map((part) =>
    IS_ANSI_ESCAPE.test(part) ? 0 : widestDisplayWidth(part),
  );
  const total = widths.reduce((sum, partWidth) => sum + partWidth, 0);
  if (total <= width) return text;

  let room = Math.max(0, width - widestDisplayWidth(marker));
  let cut = false;
  const kept: string[] = [];
  for (let index = parts.length - 1; index >= 0; index--) {
    const partWidth = widths[index]!;
    if (partWidth === 0) {
      kept.push(parts[index]!);
    } else if (!cut && partWidth <= room) {
      kept.push(parts[index]!);
      room -= partWidth;
    } else {
      cut = true;
    }
  }
  return `${marker}${kept.reverse().join("")}`;
}
