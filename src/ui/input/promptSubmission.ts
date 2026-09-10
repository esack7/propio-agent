import type { InputMode } from "../inputModes.js";
import { shouldRecordPromptHistoryEntry } from "../promptHistory.js";
import type { PromptMode } from "../promptState.js";

import type { PromptSubmission as RuntimeSubmission } from "../../agentCore/input.js";
export type { PromptImage } from "../../agentCore/input.js";
export interface PromptSubmission extends RuntimeSubmission {
  displayText: string;
  inputMode: InputMode;
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
