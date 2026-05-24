import { PASTE_THRESHOLD } from "./constants.js";
import { cleanPasteText } from "./cleanPasteText.js";
import { classifyDroppedText, isImagePath } from "./parseDroppedPaths.js";
import type { InputMode } from "../inputModes.js";

export type PasteHandlerCallbacks = {
  onTextPaste: (text: string) => void;
  onImagePaths?: (paths: readonly string[]) => void | Promise<void>;
  onEmptyPaste?: () => void | Promise<void>;
};

export type PasteHandlerOptions = PasteHandlerCallbacks & {
  getInputMode: () => InputMode;
  debounceMs?: number;
  /** Inter-key gap for burst / split-chunk detection (default ~20ms). */
  burstCharIntervalMs?: number;
};

export type PasteHandler = {
  submitPaste(text: string, meta: { isPasted: boolean }): void;
  onPrintableText(text: string): "buffered" | "typed";
  flushBeforeNonChar(): void;
  isPasting(): boolean;
  dispose(): void;
};

export { cleanPasteText } from "./cleanPasteText.js";

export function createPasteHandler(options: PasteHandlerOptions): PasteHandler {
  const debounceMs = options.debounceMs ?? 100;
  const burstCharIntervalMs = options.burstCharIntervalMs ?? 20;

  let disposed = false;
  let pendingText = "";
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let debounceActive = false;

  let burstActive = false;
  let burstBuffer = "";
  let burstIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastBurstKeyAt = 0;

  let deliveryActive = false;
  let deliveryGeneration = 0;

  const clearDebounceTimer = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const clearBurstIdleTimer = (): void => {
    if (burstIdleTimer !== null) {
      clearTimeout(burstIdleTimer);
      burstIdleTimer = null;
    }
  };

  const runDelivery = async (
    merged: string,
    generation: number,
  ): Promise<void> => {
    if (disposed || generation !== deliveryGeneration || merged.length === 0) {
      return;
    }

    const cleaned = cleanPasteText(merged);
    const { paths, allNonEmptyLinesArePaths } = classifyDroppedText(cleaned);
    const imagePaths = paths.filter(isImagePath);

    const useImageBranch =
      options.getInputMode() === "prompt" &&
      options.onImagePaths !== undefined &&
      imagePaths.length > 0 &&
      allNonEmptyLinesArePaths &&
      imagePaths.length === paths.length;

    deliveryActive = true;
    try {
      if (useImageBranch) {
        try {
          await options.onImagePaths!(imagePaths);
        } catch {
          if (!disposed && generation === deliveryGeneration) {
            options.onTextPaste(cleaned);
          }
        }
      } else {
        options.onTextPaste(cleaned);
      }
    } finally {
      if (generation === deliveryGeneration) {
        deliveryActive = false;
      }
    }
  };

  const scheduleDelivery = (merged: string): void => {
    const generation = deliveryGeneration;
    void runDelivery(merged, generation).catch(() => {
      // runDelivery handles errors; outer catch is belt-and-suspenders only.
    });
  };

  const flushDebounce = (): void => {
    clearDebounceTimer();
    if (!debounceActive) {
      return;
    }

    debounceActive = false;
    const merged = pendingText;
    pendingText = "";
    scheduleDelivery(merged);
  };

  const flushBurst = (): void => {
    clearBurstIdleTimer();
    if (!burstActive) {
      return;
    }

    burstActive = false;
    const merged = burstBuffer;
    burstBuffer = "";
    lastBurstKeyAt = 0;

    if (merged.length === 0) {
      return;
    }

    if (merged.length > 1 || merged.length > PASTE_THRESHOLD) {
      scheduleDelivery(merged);
      return;
    }

    options.onTextPaste(merged);
  };

  const scheduleDebounce = (): void => {
    clearDebounceTimer();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flushDebounce();
    }, debounceMs);
  };

  const scheduleBurstIdle = (): void => {
    clearBurstIdleTimer();
    burstIdleTimer = setTimeout(() => {
      burstIdleTimer = null;
      flushBurst();
    }, burstCharIntervalMs);
  };

  const activateBurst = (): void => {
    burstActive = true;
  };

  const runEmptyPasteDelivery = async (generation: number): Promise<void> => {
    if (
      disposed ||
      generation !== deliveryGeneration ||
      !options.onEmptyPaste
    ) {
      return;
    }

    deliveryActive = true;
    try {
      await options.onEmptyPaste();
    } finally {
      if (generation === deliveryGeneration) {
        deliveryActive = false;
      }
    }
  };

  const scheduleEmptyPasteDelivery = (): void => {
    const generation = deliveryGeneration;
    void runEmptyPasteDelivery(generation).catch(() => {
      // Empty paste delivery is best-effort.
    });
  };

  return {
    submitPaste(text: string, meta: { isPasted: boolean }): void {
      if (disposed) {
        return;
      }

      if (text.length === 0) {
        if (meta.isPasted && options.onEmptyPaste) {
          flushBurst();
          scheduleEmptyPasteDelivery();
        }
        return;
      }

      flushBurst();
      pendingText += text;
      debounceActive = true;
      scheduleDebounce();
    },

    onPrintableText(text: string): "buffered" | "typed" {
      if (disposed || text.length === 0) {
        return "typed";
      }

      if (text.length > 1) {
        activateBurst();
        burstBuffer += text;
        lastBurstKeyAt = Date.now();
        scheduleBurstIdle();
        return "buffered";
      }

      const now = Date.now();
      const interKeyGap =
        lastBurstKeyAt > 0 ? now - lastBurstKeyAt : Number.POSITIVE_INFINITY;

      if (
        burstActive &&
        lastBurstKeyAt > 0 &&
        interKeyGap > burstCharIntervalMs
      ) {
        flushBurst();
      }

      const withinBurstWindow =
        burstActive ||
        (lastBurstKeyAt > 0 && interKeyGap <= burstCharIntervalMs);

      lastBurstKeyAt = now;

      if (withinBurstWindow) {
        activateBurst();
        burstBuffer += text;
        scheduleBurstIdle();
        return "buffered";
      }

      return "typed";
    },

    flushBeforeNonChar(): void {
      if (disposed) {
        return;
      }
      flushDebounce();
      flushBurst();
    },

    isPasting(): boolean {
      return debounceActive || burstActive || deliveryActive;
    },

    dispose(): void {
      disposed = true;
      deliveryGeneration += 1;
      deliveryActive = false;
      clearDebounceTimer();
      clearBurstIdleTimer();
      debounceActive = false;
      burstActive = false;
      pendingText = "";
      burstBuffer = "";
      lastBurstKeyAt = 0;
    },
  };
}
