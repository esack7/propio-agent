import { keepEndWithinDisplayWidth } from "./displayWidth.js";
import type { HoldableStream, OutputHold } from "./holdableStream.js";

/**
 * One line of input drawn under whatever a running turn has printed so far.
 *
 * The turn's output is not line-oriented: text streams mid-line and is
 * redrawn in place. Rather than interleave with it, the line holds the
 * turn's output while it is showing and lets it catch up when it closes.
 * The turn keeps running throughout.
 */
export interface TurnInputLine {
  /** Draw or redraw the line. The first call starts holding output. */
  show(text: string): void;
  /** Erase the line, put the cursor back, and release the held output. */
  close(): void;
  readonly showing: boolean;
}

// ESC D moves down one row, scrolling if the cursor is on the last row, and
// keeps the column. Coming back up leaves the cursor where it was, with a
// row guaranteed to exist below it. ESC 7 then remembers that position and
// the text attributes in force, and ESC 8 restores both.
const RESERVE_ROW_BELOW = "\x1bD\x1b[1A";
const SAVE = "\x1b7";
const RESTORE = "\x1b8";
const TO_ROW_BELOW = "\x1b[1B\r\x1b[0m\x1b[2K";

export function createTurnInputLine(
  output: HoldableStream,
  columns: () => number,
): TurnInputLine {
  let hold: OutputHold | null = null;

  /** Keep to one row: a wrapped line would scroll and lose the saved place. */
  const fit = (text: string): string =>
    keepEndWithinDisplayWidth(text, Math.max(10, columns() - 1));

  return {
    get showing() {
      return hold !== null;
    },
    show(text) {
      if (hold === null) {
        hold = output.hold();
        if (hold === null) return;
        hold.write(`${RESERVE_ROW_BELOW}${SAVE}`);
      }
      hold.write(`${RESTORE}${TO_ROW_BELOW}${fit(text)}`);
    },
    close() {
      if (hold === null) return;
      hold.write(`${RESTORE}${TO_ROW_BELOW}${RESTORE}`);
      hold.release();
      hold = null;
    },
  };
}
