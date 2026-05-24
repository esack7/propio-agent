import { PASTE_THRESHOLD } from "./constants.js";

export function countPasteLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const segments = text.split("\n");
  if (text.endsWith("\n")) {
    segments.pop();
  }

  return segments.length;
}

function maxPasteLinesBeforeCollapse(rows: number | undefined): number {
  return Math.max(1, Math.min((rows ?? 24) - 10, 2));
}

export function shouldCollapsePaste(
  cleaned: string,
  rows: number | undefined,
): boolean {
  const lineCount = countPasteLines(cleaned);
  return (
    cleaned.length > PASTE_THRESHOLD ||
    lineCount > maxPasteLinesBeforeCollapse(rows)
  );
}

export function buildTextPastePill(id: number, lineCount: number): string {
  if (lineCount <= 1) {
    return `[Pasted text #${id}]`;
  }

  return `[Pasted text #${id} +${lineCount - 1} lines]`;
}
