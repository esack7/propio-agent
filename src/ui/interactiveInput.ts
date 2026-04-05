import * as readline from "readline";

export type InteractiveInputCloseReason = "closed" | "interrupted";

export interface InteractiveInput {
  readLine(promptText: string): Promise<string | null>;
  confirm(
    promptText: string,
    options?: { defaultValue?: boolean },
  ): Promise<boolean>;
  getCloseReason(): InteractiveInputCloseReason | null;
  close(): void;
}

export interface InteractiveInputOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export function createInteractiveInput(
  options: InteractiveInputOptions = {},
): InteractiveInput {
  const inputStream = options.input ?? process.stdin;
  const outputStream = options.output ?? process.stderr;
  const rl = readline.createInterface({
    input: inputStream,
    output: outputStream,
    terminal: Boolean(outputStream.isTTY),
  });

  let closed = false;
  let closeReason: InteractiveInputCloseReason | null = null;
  let pendingResolve: ((value: string | null) => void) | null = null;

  const setCloseReason = (reason: InteractiveInputCloseReason): void => {
    if (reason === "interrupted" || closeReason === null) {
      closeReason = reason;
    }
  };

  const settlePending = (value: string | null): void => {
    if (!pendingResolve) {
      return;
    }

    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(value);
  };

  rl.once("close", () => {
    closed = true;
    setCloseReason("closed");
    settlePending(null);
  });

  rl.on("SIGINT", () => {
    setCloseReason("interrupted");
    process.kill(process.pid, "SIGINT");
  });

  const readLine = async (promptText: string): Promise<string | null> => {
    if (closed) {
      return null;
    }

    if (pendingResolve) {
      throw new Error("An interactive prompt is already active.");
    }

    return await new Promise<string | null>((resolve) => {
      let settled = false;
      pendingResolve = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        pendingResolve = null;
        resolve(value);
      };

      rl.question(promptText, (answer) => {
        pendingResolve?.(answer);
      });
    });
  };

  const confirm = async (
    promptText: string,
    options: { defaultValue?: boolean } = {},
  ): Promise<boolean> => {
    const defaultValue = options.defaultValue ?? false;

    while (true) {
      const answer = await readLine(promptText);

      if (answer === null) {
        return defaultValue;
      }

      const normalized = answer.trim().toLowerCase();

      if (normalized === "") {
        return defaultValue;
      }

      if (normalized === "y" || normalized === "yes") {
        return true;
      }

      if (normalized === "n" || normalized === "no") {
        return false;
      }

      outputStream.write("Invalid response. Please enter y or n.\n");
    }
  };

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    setCloseReason("closed");
    rl.close();
  };

  return {
    readLine,
    confirm,
    getCloseReason: () => closeReason,
    close,
  };
}
