import { visibleText } from "./visibleText.js";

export type ToolCallStatus = "running" | "success" | "error";

export interface ToolCallView {
  readonly id: string;
  readonly toolName: string;
  readonly status: ToolCallStatus;
  readonly useLabel: string;
  readonly resultLabel: string | null;
}

/**
 * The view with every field that came from the model or a tool rendered
 * visibly. A tool's use label carries its arguments (a bash command, a path)
 * and its result label carries output, so either could otherwise move the
 * cursor or erase lines before the approval question is drawn.
 */
export function visibleToolCallView(view: ToolCallView): ToolCallView {
  return {
    ...view,
    toolName: visibleText(view.toolName),
    useLabel: visibleText(view.useLabel),
    resultLabel:
      view.resultLabel === null ? null : visibleText(view.resultLabel),
  };
}
