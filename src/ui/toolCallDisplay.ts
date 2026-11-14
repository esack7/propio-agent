import type { ToolDisplay } from "../tools/display.js";
import type { DisplayState } from "./toolDisplay/render.js";
export interface ToolCallDisplay extends DisplayState {
  readonly id: string;
  readonly toolName: string;
  readonly display: ToolDisplay;
  readonly fullOutputPath?: string;
}
