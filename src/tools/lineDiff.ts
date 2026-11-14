import { utf8Head, utf8Length } from "./display.js";
import type { DiffHunk, DiffLine } from "./display.js";

export interface LineDiff {
  readonly hunks: readonly DiffHunk[];
  /** Lines added and removed in the whole change, including any left out. */
  readonly added: number;
  readonly removed: number;
  /** The hunks hold fewer lines, or less text, than the change has. */
  readonly truncated: boolean;
}

export interface LineDiffOptions {
  /** Unchanged lines kept around each change. */
  readonly context?: number;
  /** Most lines kept across all hunks. */
  readonly maxLines?: number;
  /** Most UTF-8 bytes of line text kept across all hunks. */
  readonly maxBytes?: number;
  /**
   * When to stop looking for the smallest diff. Past it the differing middle
   * is shown as one replacement, which is still correct. The clock is the
   * caller's, so this module reads none.
   */
  readonly deadline?: { readonly at: number; now(): number };
}

/** Above this many differing steps the middle is shown as one replacement. */
const MAX_EDIT_DISTANCE = 1000;

/**
 * The lines of a text, each with the line break that ends it. The last line
 * has none when the text does not end in one, so gaining or losing a final
 * line break changes that line. Carriage returns stay in the line they end.
 */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    if (end === -1) {
      lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, end + 1));
    start = end + 1;
  }
  return lines;
}

type Op = " " | "+" | "-";

/** Furthest old-text positions reached on each diagonal, indexed from `offset`. */
type Frontier = Int32Array;

/** Whether the path to diagonal k at distance d arrives by adding a line. */
function arrivesByInsert(
  v: Frontier,
  offset: number,
  k: number,
  d: number,
): boolean {
  return k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
}

/** Follow matching lines from (x, x - k) and return the old-text position reached. */
function followMatches(
  a: readonly string[],
  b: readonly string[],
  x: number,
  k: number,
): number {
  while (x < a.length && x - k < b.length && a[x] === b[x - k]) x++;
  return x;
}

/** Myers' shortest edit script over lines, or undefined past the distance limit. */
function shortestEdit(
  a: readonly string[],
  b: readonly string[],
  deadline: LineDiffOptions["deadline"],
): Op[] | undefined {
  const max = Math.min(a.length + b.length, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v: Frontier = new Int32Array(2 * max + 3);
  const trace: Frontier[] = [];
  for (let d = 0; d <= max; d++) {
    if (deadline && deadline.now() > deadline.at) return undefined;
    trace.push(v);
    v = v.slice();
    for (let k = -d; k <= d; k += 2) {
      const start = arrivesByInsert(v, offset, k, d)
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      const x = followMatches(a, b, start, k);
      v[offset + k] = x;
      if (x >= a.length && x - k >= b.length) {
        return backtrack(trace, a.length, b.length, d, offset);
      }
    }
  }
  return undefined;
}

function backtrack(
  trace: readonly Frontier[],
  n: number,
  m: number,
  distance: number,
  offset: number,
): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  const keep = (untilX: number, untilY: number): void => {
    while (x > untilX && y > untilY) {
      ops.push(" ");
      x--;
      y--;
    }
  };
  for (let d = distance; d > 0; d--) {
    const k = x - y;
    const insert = arrivesByInsert(trace[d], offset, k, d);
    const prevK = insert ? k + 1 : k - 1;
    const prevX = trace[d][offset + prevK];
    keep(prevX, prevX - prevK);
    ops.push(insert ? "+" : "-");
    if (insert) y--;
    else x--;
  }
  keep(0, 0);
  return ops.reverse();
}

/**
 * The edit script for the part of the two texts that differs, with up to
 * `context` unchanged lines on each side. Lines further out cannot appear in
 * a hunk, so no work is spent on them.
 */
interface EditWindow {
  readonly ops: readonly Op[];
  /** 0-based line where the window starts, the same in both texts. */
  readonly start: number;
  readonly added: number;
  readonly removed: number;
}

/** How many lines the two texts share at the start and, after that, at the end. */
function commonEnds(
  a: readonly string[],
  b: readonly string[],
): { prefix: number; suffix: number } {
  const shorter = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < shorter && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { prefix, suffix };
}

/**
 * Write the middle of the edit script into `ops` from `at`: the smallest
 * edit if one was found, otherwise every old line removed and every new one
 * added. Returns the lines added and removed.
 */
function writeMiddle(
  ops: Op[],
  at: number,
  found: readonly Op[] | undefined,
  removedLines: number,
  addedLines: number,
): { added: number; removed: number } {
  if (!found) {
    ops.fill("-", at, at + removedLines);
    ops.fill("+", at + removedLines, at + removedLines + addedLines);
    return { added: addedLines, removed: removedLines };
  }
  let added = 0;
  let removed = 0;
  for (let i = 0; i < found.length; i++) {
    ops[at + i] = found[i];
    if (found[i] === "+") added++;
    else if (found[i] === "-") removed++;
  }
  return { added, removed };
}

function editWindow(
  a: readonly string[],
  b: readonly string[],
  context: number,
  deadline: LineDiffOptions["deadline"],
): EditWindow {
  const { prefix, suffix } = commonEnds(a, b);
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const lead = Math.min(prefix, context);
  const trail = Math.min(suffix, context);
  // Past the deadline or the distance limit, the middle is one replacement.
  const found = shortestEdit(midA, midB, deadline);
  const middleLength = found ? found.length : midA.length + midB.length;
  const ops = new Array<Op>(lead + middleLength + trail).fill(" ");
  const counts = writeMiddle(ops, lead, found, midA.length, midB.length);
  return { ops, start: prefix - lead, ...counts };
}

/** A run of ops to show, and where it starts in each text (0-based). */
interface HunkRange {
  readonly start: number;
  end: number;
  oldIndex: number;
  newIndex: number;
}

/** Each change with its context, merged where they meet. */
function changeRanges(ops: readonly Op[], context: number): HunkRange[] {
  const ranges: HunkRange[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i] === " ") continue;
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end, oldIndex: 0, newIndex: 0 });
  }
  return ranges;
}

/** Ranges of ops to show, each with where it starts in the two texts. */
function hunkRanges(window: EditWindow, context: number): HunkRange[] {
  const { ops } = window;
  const ranges = changeRanges(ops, context);
  let next = 0;
  let oldIndex = window.start;
  let newIndex = window.start;
  for (let i = 0; next < ranges.length; i++) {
    if (ranges[next].start === i) {
      ranges[next].oldIndex = oldIndex;
      ranges[next].newIndex = newIndex;
      next++;
    }
    if (ops[i] !== "+") oldIndex++;
    if (ops[i] !== "-") newIndex++;
  }
  return ranges;
}

/** What is left to spend on hunk lines. */
interface Budget {
  lines: number;
  bytes: number;
  /** Something was left out or shortened. */
  spent: boolean;
}

/** A line as shown: its text without the line break, cut to the budget. */
function shownLine(op: Op, line: string, budget: Budget): DiffLine {
  const terminated = line.endsWith("\n");
  const text = terminated ? line.slice(0, -1) : line;
  const size = utf8Length(text);
  const fits = size <= budget.bytes;
  const shown = fits ? text : utf8Head(text, budget.bytes);
  budget.lines--;
  budget.bytes -= fits ? size : budget.bytes;
  if (!fits) budget.spent = true;
  return {
    op,
    text: shown,
    ...(terminated ? {} : { noNewline: true as const }),
    ...(fits ? {} : { truncated: true as const }),
  };
}

/** One hunk from a range of ops, as far as the budget allows. */
function buildHunk(
  ops: readonly Op[],
  range: HunkRange,
  a: readonly string[],
  b: readonly string[],
  budget: Budget,
): DiffHunk {
  const lines: DiffLine[] = [];
  let oldIndex = range.oldIndex;
  let newIndex = range.newIndex;
  for (let i = range.start; i <= range.end; i++) {
    if (budget.lines <= 0 || budget.bytes <= 0) {
      budget.spent = true;
      break;
    }
    const op = ops[i];
    lines.push(shownLine(op, op === "+" ? b[newIndex] : a[oldIndex], budget));
    if (op !== "+") oldIndex++;
    if (op !== "-") newIndex++;
  }
  // A side with no lines in the hunk starts at the line before it.
  const hasOld = oldIndex > range.oldIndex;
  const hasNew = newIndex > range.newIndex;
  return {
    oldStart: hasOld ? range.oldIndex + 1 : range.oldIndex,
    newStart: hasNew ? range.newIndex + 1 : range.newIndex,
    lines,
  };
}

/**
 * A line-based diff of two texts as hunks with context. Applying the hunks
 * to the old lines gives the new lines, unless the result is truncated.
 */
export function diffLines(
  oldText: string,
  newText: string,
  options: LineDiffOptions = {},
): LineDiff {
  const context = options.context ?? 3;
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const window = editWindow(a, b, context, options.deadline);
  const budget: Budget = {
    lines: options.maxLines ?? Number.POSITIVE_INFINITY,
    bytes: options.maxBytes ?? Number.POSITIVE_INFINITY,
    spent: false,
  };
  const hunks: DiffHunk[] = [];
  for (const range of hunkRanges(window, context)) {
    if (budget.lines <= 0 || budget.bytes <= 0) {
      budget.spent = true;
      break;
    }
    const hunk = buildHunk(window.ops, range, a, b, budget);
    if (hunk.lines.length > 0) hunks.push(hunk);
  }
  return {
    hunks,
    added: window.added,
    removed: window.removed,
    truncated: budget.spent,
  };
}
