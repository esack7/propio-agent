import type { TypeaheadSummary } from "./typeahead.js";
import type { HistorySearchSummary } from "./historySearch.js";

export type PromptMode = "chat" | "confirm" | "menu";

export interface PromptState {
  buffer: string;
  cursor: number;
  mode: PromptMode;
  placeholder?: string;
  footer?: string;
  history?: readonly string[];
  historySearch?: HistorySearchSummary;
  typeahead?: TypeaheadSummary;
  multiline?: boolean;
  editorStatus?: string;
}

export interface PromptRequest {
  promptText: string;
  mode: PromptMode;
  placeholder?: string;
  footer?: string;
  defaultValue?: string;
  history?: readonly string[];
}

export function clampPromptCursor(
  cursor: number,
  bufferLength: number,
): number {
  return Math.max(0, Math.min(cursor, bufferLength));
}

export function createPromptState(request: PromptRequest): PromptState {
  const buffer = request.defaultValue ?? "";
  return {
    buffer,
    cursor: clampPromptCursor(buffer.length, buffer.length),
    mode: request.mode,
    placeholder: request.placeholder,
    footer: request.footer,
    history: request.history ? [...request.history] : undefined,
    multiline: buffer.includes("\n"),
  };
}

export function applySubmittedText(
  state: PromptState,
  submittedText: string,
): PromptState {
  const buffer = submittedText;
  return {
    ...state,
    buffer,
    cursor: clampPromptCursor(buffer.length, buffer.length),
    historySearch: undefined,
    typeahead: undefined,
    multiline: buffer.includes("\n"),
    editorStatus: undefined,
  };
}
