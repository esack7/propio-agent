import type { ToolDisplay } from "../tools/display.js";
import type { DisplayState } from "./toolDisplay/render.js";
export interface ToolCallDisplay extends DisplayState {
  /** Temporarily hidden while its approval prompt shows the same preview. */
  readonly hidden?: boolean;
  readonly id: string;
  readonly toolName: string;
  readonly display: ToolDisplay;
}
