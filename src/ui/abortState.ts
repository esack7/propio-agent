import type { TerminalUi } from "./terminal.js";
import type { PromptComposer } from "./promptComposer.js";

export type TurnCancelSource = "escape" | "sigint";

export interface AbortStateController {
  shouldExit: () => boolean;
  setCurrentAbortController: (controller: AbortController | null) => void;
  setActiveComposer: (composer: PromptComposer | null) => void;
  cancelActiveTurn: (source: TurnCancelSource) => boolean;
  handleSigint: () => void;
}

export function resolveInteractiveTurnAbortExitCode(
  abortSignal: AbortSignal,
  shouldExit: () => boolean,
): number | null {
  if (shouldExit()) {
    return 130;
  }

  if (abortSignal.reason === "escape") {
    return null;
  }

  return 130;
}

export function createAbortStateController(
  ui: TerminalUi,
): AbortStateController {
  let shouldExit = false;
  let currentAbortController: AbortController | null = null;
  let activeComposer: PromptComposer | null = null;

  return {
    shouldExit: () => shouldExit,
    setCurrentAbortController: (controller) => {
      currentAbortController = controller;
    },
    setActiveComposer: (composer) => {
      activeComposer = composer;
    },
    cancelActiveTurn: (source) => {
      if (!currentAbortController || currentAbortController.signal.aborted) {
        return false;
      }

      currentAbortController.abort(source);
      if (source === "escape") {
        ui.warn("Turn cancelled.");
        ui.setMode("awaitingInput");
      }

      return true;
    },
    handleSigint: () => {
      shouldExit = true;
      ui.setMode("error");
      activeComposer?.close();
      if (currentAbortController && !currentAbortController.signal.aborted) {
        currentAbortController.abort("sigint");
        ui.warn("Cancellation requested (SIGINT).");
        return;
      }

      ui.warn("Interrupted.");
    },
  };
}
