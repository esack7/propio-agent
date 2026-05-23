import type * as readline from "readline";

export interface TurnCancelListenerOptions {
  input: NodeJS.ReadStream;
  onCancel: () => void;
  /** When false, attach is a no-op (non-TTY / CI / piped stdin). */
  interactiveInput?: boolean;
  /** Test harness only; production relies on prior emitKeypressEvents from the prompt. */
  enableKeypressEvents?: (input: NodeJS.ReadStream) => void;
}

type KeypressHandler = (str: string | undefined, key: readline.Key) => void;

type RawModeStream = NodeJS.ReadStream & {
  setRawMode?: (mode: boolean) => void;
  isRaw?: boolean;
};

function setRawMode(input: NodeJS.ReadStream, enabled: boolean): void {
  (input as RawModeStream).setRawMode?.(enabled);
}

function isInteractiveInput(
  input: NodeJS.ReadStream,
  interactiveInput: boolean | undefined,
): boolean {
  if (interactiveInput !== undefined) {
    return interactiveInput;
  }

  return Boolean(input.isTTY) && Boolean(process.stdout.isTTY);
}

export interface TurnCancelListener {
  attach(): void;
  detach(): void;
}

export function createTurnCancelListener(
  options: TurnCancelListenerOptions,
): TurnCancelListener {
  let attached = false;
  let enabledRawMode = false;

  const handleKeypress: KeypressHandler = (_str, key) => {
    if (key.name === "escape") {
      options.onCancel();
    }
  };

  return {
    attach(): void {
      if (attached) {
        return;
      }

      if (!isInteractiveInput(options.input, options.interactiveInput)) {
        return;
      }

      options.enableKeypressEvents?.(options.input);

      const stream = options.input as RawModeStream;
      const wasRaw = stream.isRaw === true;

      options.input.resume();
      if (!wasRaw) {
        setRawMode(options.input, true);
        enabledRawMode = true;
      }

      options.input.on("keypress", handleKeypress as never);
      attached = true;
    },

    detach(): void {
      if (!attached) {
        return;
      }

      options.input.removeListener("keypress", handleKeypress as never);

      if (enabledRawMode) {
        setRawMode(options.input, false);
        enabledRawMode = false;
      }

      if (typeof options.input.pause === "function") {
        options.input.pause();
      }

      attached = false;
    },
  };
}
