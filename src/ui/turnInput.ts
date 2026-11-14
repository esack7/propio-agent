import type * as readline from "readline";
import { isPrintableKey, lineKeyAction } from "./keyLineReader.js";
import type { TurnInputLine } from "./turnInputLine.js";

export interface TurnInputOptions {
  input: NodeJS.ReadStream;
  /** When false, attach is a no-op (non-TTY / CI / piped stdin). */
  interactiveInput?: boolean;
  /** Where the line being typed is drawn. Without it only Escape is read. */
  line: TurnInputLine | null;
  /** Text that introduces the line, such as a prompt symbol. */
  promptText: string;
  /** Send guidance to the running turn. Returns false if it was refused. */
  onGuide: (text: string) => boolean;
  onInterrupt: () => void;
  /** Test harness only; production relies on prior emitKeypressEvents from the prompt. */
  enableKeypressEvents?: (input: NodeJS.ReadStream) => void;
}

/**
 * The keyboard while a turn runs. Typing writes a line of guidance and Enter
 * sends it to the turn without stopping it; Escape interrupts the turn.
 */
export interface TurnInput {
  attach(): void;
  /** Stop reading. Returns what was typed and not sent. */
  detach(): string;
  /** Give the keyboard and the screen to something else, keeping the draft. */
  suspend(): void;
  resume(): void;
}

type RawModeStream = NodeJS.ReadStream & {
  setRawMode?: (mode: boolean) => void;
  isRaw?: boolean;
};

const COMMAND_HINT = "  (commands run when the turn ends)";

function isInteractive(
  input: NodeJS.ReadStream,
  interactiveInput: boolean | undefined,
): boolean {
  return interactiveInput !== undefined
    ? interactiveInput
    : Boolean(input.isTTY) && Boolean(process.stdout.isTTY);
}

export function createTurnInput(options: TurnInputOptions): TurnInput {
  const { input, line } = options;
  let attached = false;
  let enabledRawMode = false;
  let suspended = false;
  let draft = "";
  let hint = "";

  const draw = (): void => {
    if (!line || suspended) return;
    if (draft.length === 0) {
      line.close();
      return;
    }
    line.show(`${options.promptText}${draft}${hint}`);
  };

  const setDraft = (next: string): void => {
    draft = next;
    hint = "";
    draw();
  };

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0) {
      setDraft("");
      return;
    }
    // A command typed mid-turn would otherwise reach the model as text.
    if (text.startsWith("/") || text.startsWith("!")) {
      hint = COMMAND_HINT;
      draw();
      return;
    }
    // Clear the line before the guidance is announced, so the announcement
    // is written to a screen that has caught up.
    const sending = draft;
    setDraft("");
    if (!options.onGuide(text)) setDraft(sending);
  };

  const eraseLast = (): void => {
    const characters = Array.from(draft);
    characters.pop();
    setDraft(characters.join(""));
  };

  const onKeypress = (text: string | undefined, key: readline.Key): void => {
    if (key.name === "escape") {
      // The draft is kept: the caller returns it to the prompt.
      line?.close();
      options.onInterrupt();
      return;
    }
    if (suspended || !line) return;
    switch (lineKeyAction(key)) {
      case "submit":
        submit();
        return;
      case "erase":
        eraseLast();
        return;
      case "clear":
      case "withdraw":
        setDraft("");
        return;
      default:
        if (isPrintableKey(text, key)) setDraft(draft + text);
    }
  };

  return {
    attach(): void {
      if (attached || !isInteractive(input, options.interactiveInput)) return;
      options.enableKeypressEvents?.(input);
      const stream = input as RawModeStream;
      input.resume();
      if (stream.isRaw !== true) {
        stream.setRawMode?.(true);
        enabledRawMode = true;
      }
      input.on("keypress", onKeypress as never);
      attached = true;
    },

    detach(): string {
      line?.close();
      const left = draft;
      draft = "";
      hint = "";
      if (!attached) return left;
      input.removeListener("keypress", onKeypress as never);
      if (enabledRawMode) {
        (input as RawModeStream).setRawMode?.(false);
        enabledRawMode = false;
      }
      if (typeof input.pause === "function") input.pause();
      attached = false;
      return left;
    },

    suspend(): void {
      if (suspended) return;
      line?.close();
      suspended = true;
    },

    resume(): void {
      if (!suspended) return;
      suspended = false;
      draw();
    },
  };
}
