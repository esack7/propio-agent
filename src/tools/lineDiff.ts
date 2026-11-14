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
): Op[] | undefined {
  const max = Math.min(a.length + b.length, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v: Frontier = new Int32Array(2 * max + 3);
  const trace: Frontier[] = [];
  for (let d = 0; d <= max; d++) {
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

function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const middle: Op[] = shortestEdit(midA, midB) ?? [
    ...midA.map((): Op => "-"),
    ...midB.map((): Op => "+"),
  ];
  return [
    ...new Array<Op>(prefix).fill(" "),
    ...middle,
    ...new Array<Op>(suffix).fill(" "),
  ];
}

interface Step {
  readonly op: Op;
  /** 0-based index of this line in the old and new text. */
  readonly oldIndex: number;
  readonly newIndex: number;
}

function toSteps(ops: readonly Op[]): Step[] {
  const steps: Step[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const op of ops) {
    steps.push({ op, oldIndex, newIndex });
    if (op !== "+") oldIndex++;
    if (op !== "-") newIndex++;
  }
  return steps;
}

/** Ranges of steps to show: each change with its context, merged where they meet. */
function hunkRanges(
  steps: readonly Step[],
  context: number,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].op === " ") continue;
    const start = Math.max(0, i - context);
    const end = Math.min(steps.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
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

/** One hunk from a range of steps, as far as the budget allows. */
function buildHunk(
  steps: readonly Step[],
  [start, end]: readonly [number, number],
  a: readonly string[],
  b: readonly string[],
  budget: Budget,
): DiffHunk {
  const lines: DiffLine[] = [];
  let hasOld = false;
  let hasNew = false;
  for (let i = start; i <= end; i++) {
    if (budget.lines <= 0 || budget.bytes <= 0) {
      budget.spent = true;
      break;
    }
    const step = steps[i];
    lines.push(
      shownLine(
        step.op,
        step.op === "+" ? b[step.newIndex] : a[step.oldIndex],
        budget,
      ),
    );
    if (step.op !== "+") hasOld = true;
    if (step.op !== "-") hasNew = true;
  }
  const first = steps[start];
  // A side with no lines in the hunk starts at the line before it.
  return {
    oldStart: hasOld ? first.oldIndex + 1 : first.oldIndex,
    newStart: hasNew ? first.newIndex + 1 : first.newIndex,
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
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const steps = toSteps(editScript(a, b));
  const budget: Budget = {
    lines: options.maxLines ?? Number.POSITIVE_INFINITY,
    bytes: options.maxBytes ?? Number.POSITIVE_INFINITY,
    spent: false,
  };
  const hunks: DiffHunk[] = [];
  for (const range of hunkRanges(steps, options.context ?? 3)) {
    if (budget.lines <= 0 || budget.bytes <= 0) {
      budget.spent = true;
      break;
    }
    const hunk = buildHunk(steps, range, a, b, budget);
    if (hunk.lines.length > 0) hunks.push(hunk);
  }
  return {
    hunks,
    added: steps.filter((step) => step.op === "+").length,
    removed: steps.filter((step) => step.op === "-").length,
    truncated: budget.spent,
  };
}
