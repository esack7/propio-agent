import type { ExecutableTool as ExecutionTool } from "./execution.js";
import type { ToolDisplay } from "./display.js";
import type { ToolExecutionResult } from "./types.js";

/** What a tool may rely on while describing a call that has not run. */
export interface ToolDescribeContext {
  /**
   * Whether the file at this path, as the caller wrote it, may be read to
   * describe a call nobody has approved yet. Without it, reading is allowed.
   */
  canPreviewRead?(rawPath: string): boolean | Promise<boolean>;
}

/**
 * Describing a call is optional and separate from the execution contract: a
 * registry that only executes never calls these.
 */
export interface PresentedTool extends ExecutionTool {
  /**
   * The call as it would run, before anyone has approved it. It must change
   * nothing. It may read, within what the context allows.
   */
  describeCall?(
    args: Readonly<Record<string, unknown>>,
    context?: ToolDescribeContext,
  ): ToolDisplay | Promise<ToolDisplay>;
  /** The call with what its result adds: counts, exit status, a failure. */
  describeResult?(
    args: Readonly<Record<string, unknown>>,
    result: Readonly<ToolExecutionResult>,
    before: ToolDisplay,
  ): ToolDisplay;
}
