import * as readline from "readline";
import {
  applySubmittedText,
  createPromptState,
  type PromptRequest,
  type PromptState,
} from "./promptState.js";

export type { PromptMode, PromptState, PromptRequest } from "./promptState.js";

export type PromptCloseReason = "closed" | "interrupted";

export interface PromptResultSubmitted {
  status: "submitted";
  text: string;
}

export interface PromptResultClosed {
  status: "closed";
}

export type PromptResult = PromptResultSubmitted | PromptResultClosed;

export interface PromptConfirmRequest {
  promptText: string;
  defaultValue?: boolean;
  footer?: string;
}

export interface PromptComposer {
  compose(request: PromptRequest): Promise<PromptResult>;
  confirm(request: PromptConfirmRequest): Promise<boolean>;
  getState(): PromptState | null;
  getCloseReason(): PromptCloseReason | null;
  close(): void;
}

export interface PromptComposerOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  createInterface?: typeof readline.createInterface;
  renderFooter?: (footer: string) => void;
}

export function createPromptComposer(
  options: PromptComposerOptions = {},
): PromptComposer {
  const inputStream = options.input ?? process.stdin;
  const outputStream = options.output ?? process.stderr;
  const createInterface = options.createInterface ?? readline.createInterface;
  const rl = createInterface({
    input: inputStream,
    output: outputStream,
    terminal: Boolean(outputStream.isTTY),
  });

  let closed = false;
  let closeReason: PromptCloseReason | null = null;
  let pendingResolve: ((result: PromptResult) => void) | null = null;
  let currentState: PromptState | null = null;

  const setCloseReason = (reason: PromptCloseReason): void => {
    if (reason === "interrupted" || closeReason === null) {
      closeReason = reason;
    }
  };

  const settlePending = (result: PromptResult): void => {
    if (!pendingResolve) {
      return;
    }

    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(result);
  };

  rl.once("close", () => {
    closed = true;
    setCloseReason("closed");
    settlePending({ status: "closed" });
  });

  rl.on("SIGINT", () => {
    setCloseReason("interrupted");
    process.kill(process.pid, "SIGINT");
  });

  const compose = async (request: PromptRequest): Promise<PromptResult> => {
    if (closed) {
      return { status: "closed" };
    }

    if (pendingResolve) {
      throw new Error("An interactive prompt is already active.");
    }

    currentState = createPromptState(request);
    if (request.footer && options.renderFooter) {
      options.renderFooter(request.footer);
    }

    return await new Promise<PromptResult>((resolve) => {
      let settled = false;
      pendingResolve = (result) => {
        if (settled) {
          return;
        }

        settled = true;
        pendingResolve = null;

        if (result.status === "submitted" && currentState) {
          currentState = applySubmittedText(currentState, result.text);
        }

        resolve(result);
      };

      rl.question(request.promptText, (answer) => {
        pendingResolve?.({ status: "submitted", text: answer });
      });
    });
  };

  const confirm = async (request: PromptConfirmRequest): Promise<boolean> => {
    const defaultValue = request.defaultValue ?? false;

    while (true) {
      const result = await compose({
        mode: "confirm",
        promptText: request.promptText,
        footer: request.footer,
      });

      if (result.status === "closed") {
        return defaultValue;
      }

      const normalized = result.text.trim().toLowerCase();

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
    compose,
    confirm,
    getState: () =>
      currentState
        ? {
            ...currentState,
            history: currentState.history
              ? [...currentState.history]
              : undefined,
          }
        : null,
    getCloseReason: () => closeReason,
    close,
  };
}
