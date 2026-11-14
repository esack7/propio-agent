import { ToolRegistry as ExecutionRegistry } from "./executionRegistry.js";
import { genericDisplay, type ToolDisplay } from "./display.js";
import type { PresentedTool, ToolDescribeContext } from "./interface.js";
import type { ToolExecutionResult } from "./types.js";
export type { ToolSummary } from "./executionRegistry.js";

/** CLI presentation adapter over the public execution registry. */
export class ToolRegistry extends ExecutionRegistry {
  /**
   * What a call would do, for display before it runs. A tool that describes
   * nothing, or whose description fails, gets the generic one.
   */
  async describeCall(
    name: string,
    args: Readonly<Record<string, unknown>>,
    context?: ToolDescribeContext,
  ): Promise<ToolDisplay> {
    const tool: PresentedTool | undefined = this.tools.get(name);
    if (tool?.describeCall) {
      try {
        return await tool.describeCall(args, context);
      } catch {
        // Fall through to the generic description.
      }
    }
    return genericDisplay(name, args);
  }

  /** What a call did, for display once it has a result. */
  describeResult(
    name: string,
    args: Readonly<Record<string, unknown>>,
    result: Readonly<ToolExecutionResult>,
    before: ToolDisplay,
  ): ToolDisplay {
    const tool: PresentedTool | undefined = this.tools.get(name);
    if (tool?.describeResult) {
      try {
        return tool.describeResult(args, result, before);
      } catch {
        // Fall through to the generic description.
      }
    }
    return genericDisplay(before.title, args, {
      content: result.content,
      failed: result.status !== "success",
    });
  }
}
