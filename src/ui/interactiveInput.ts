import {
  createPromptComposer,
  type PromptCloseReason,
  type PromptComposer,
} from "./promptComposer.js";
import type { PromptHistoryStore } from "./promptHistory.js";

export type InteractiveInputCloseReason = PromptCloseReason;

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
  historyStore?: PromptHistoryStore;
  createComposer?: (
    options: InteractiveInputOptions,
  ) => Pick<PromptComposer, "compose" | "confirm" | "getCloseReason" | "close">;
}

export function createInteractiveInput(
  options: InteractiveInputOptions = {},
): InteractiveInput {
  const composer =
    options.createComposer?.(options) ?? createPromptComposer(options);

  return {
    readLine: async (promptText: string): Promise<string | null> => {
      const result = await composer.compose({
        mode: "chat",
        promptText,
      });
      return result.status === "submitted" ? result.text : null;
    },
    confirm: async (
      promptText: string,
      confirmOptions: { defaultValue?: boolean } = {},
    ): Promise<boolean> => {
      return await composer.confirm({
        promptText,
        defaultValue: confirmOptions.defaultValue,
      });
    },
    getCloseReason: () => composer.getCloseReason(),
    close: () => composer.close(),
  };
}
