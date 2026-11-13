import * as readline from "readline";

type RawInput = NodeJS.ReadStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
};

export interface KeyLineReaderOptions {
  readonly input: NodeJS.ReadStream;
  readonly output: Pick<NodeJS.WritableStream, "write">;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

function isPrintable(text: string | undefined, key: readline.Key): boolean {
  return (
    typeof text === "string" &&
    text.length > 0 &&
    key.ctrl !== true &&
    key.meta !== true &&
    !CONTROL_CHARACTER.test(text)
  );
}

type KeyAction = "submit" | "withdraw" | "erase" | "clear" | "none";

const CONTROL_KEY_ACTIONS: Readonly<Record<string, KeyAction>> = {
  c: "withdraw",
  d: "withdraw",
  u: "clear",
};
const PLAIN_KEY_ACTIONS: Readonly<Record<string, KeyAction>> = {
  return: "submit",
  enter: "submit",
  backspace: "erase",
};

/** What a key does to the line, apart from being typed into it. */
function keyAction(key: readline.Key): KeyAction {
  const table = key.ctrl === true ? CONTROL_KEY_ACTIONS : PLAIN_KEY_ACTIONS;
  const name = key.name ?? "";
  return Object.prototype.hasOwnProperty.call(table, name)
    ? table[name]!
    : "none";
}

/**
 * Read one line a key at a time, echoing it. While a turn runs the terminal
 * is in raw mode so that Escape can cancel it, and in raw mode nothing typed
 * is echoed or line-edited for us; a question asked mid-turn therefore has to
 * do both itself. Resolves to the line, or to null when the question is
 * withdrawn (Ctrl+C, Ctrl+D, or the signal aborting).
 */
export function readLineFromKeys(
  options: KeyLineReaderOptions,
  promptText: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const input = options.input as RawInput;
  const { output } = options;
  if (signal?.aborted) return Promise.resolve(null);

  return new Promise<string | null>((resolve) => {
    let buffer = "";
    readline.emitKeypressEvents(input);
    const enabledRawMode = input.isRaw !== true;
    if (enabledRawMode) input.setRawMode?.(true);
    input.resume();
    output.write(promptText);

    const finish = (line: string | null): void => {
      input.removeListener("keypress", onKeypress);
      signal?.removeEventListener("abort", onAbort);
      if (enabledRawMode) input.setRawMode?.(false);
      output.write("\n");
      resolve(line);
    };
    const onAbort = (): void => finish(null);
    const eraseLast = (): void => {
      const characters = Array.from(buffer);
      if (characters.pop() === undefined) return;
      buffer = characters.join("");
      output.write("\b \b");
    };
    const actions: Record<Exclude<KeyAction, "none">, () => void> = {
      submit: () => finish(buffer),
      withdraw: () => finish(null),
      erase: eraseLast,
      clear: () => {
        while (buffer.length > 0) eraseLast();
      },
    };
    const onKeypress = (text: string | undefined, key: readline.Key): void => {
      const action = keyAction(key);
      if (action !== "none") {
        actions[action]();
      } else if (isPrintable(text, key)) {
        buffer += text;
        output.write(text as string);
      }
    };

    input.on("keypress", onKeypress);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
