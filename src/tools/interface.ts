import type { ExecutableTool as ExecutionTool } from "./execution.js";
import type { ToolDisplayAdapter } from "./displayAdapter.js";

/** Runtime presentation is optional and separate from the public execution contract. */
export interface PresentedTool extends ExecutionTool {
  getInvocationLabel?(args: Record<string, unknown>): string | undefined;
  getDisplayAdapter?(): ToolDisplayAdapter;
}
