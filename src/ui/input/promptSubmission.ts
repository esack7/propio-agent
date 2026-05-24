import type { InputMode } from "../inputModes.js";
import { shouldRecordPromptHistoryEntry } from "../promptHistory.js";
import type { PromptMode } from "../promptState.js";

/** Runtime image bytes for providers — NOT PersistedImage (session JSON only). */
export type PromptImage = Uint8Array | string;

export interface PromptSubmission {
  /** Expanded text sent to the agent (placeholders resolved). */
  text: string;
  /** What the user saw in the prompt buffer (may contain pills). */
  displayText: string;
  inputMode: InputMode;
  /** Provider-ready attachments; omitted when none. */
  images?: PromptImage[];
}

export const HISTORY_INLINE_MAX = 1024;

/** Matches text produced by {@link expandSubmit} for image pills. */
const attachedImageMarkerPattern = /\[Attached image: [^\]]+\]/g;

export function stripAttachedImageMarkers(text: string): string {
  return text.replace(attachedImageMarkerPattern, "").trim();
}

/** True when attachments are present and expanded text is only attachment markers. */
export function isImageOnlySubmission(submission: PromptSubmission): boolean {
  if ((submission.images?.length ?? 0) === 0) {
    return false;
  }

  return stripAttachedImageMarkers(submission.text).length === 0;
}

export function shouldPersistPromptHistory(
  submission: PromptSubmission,
  promptMode: PromptMode,
): boolean {
  if (isImageOnlySubmission(submission)) {
    return false;
  }

  return (
    promptMode === "chat" && shouldRecordPromptHistoryEntry(submission.text)
  );
}

export function isSubmissionEmpty(submission: PromptSubmission): boolean {
  if (submission.text.trim().length > 0) {
    return false;
  }
  return (submission.images?.length ?? 0) === 0;
}

export function createPlainSubmission(
  text: string,
  inputMode: InputMode,
): PromptSubmission {
  return {
    text,
    displayText: text,
    inputMode,
  };
}
