import { ToolRegistry as ExecutionRegistry } from "./executionRegistry.js";
import type { PresentedTool } from "./interface.js";
export type { ToolSummary } from "./executionRegistry.js";

/** CLI presentation adapter over the public execution registry. */
export class ToolRegistry extends ExecutionRegistry {
  /**
   * Render a human-facing summary of a tool result for display.
   * Uses the tool's display adapter if available, otherwise falls back to a
   * compact truncated preview of the raw result.
   */
  renderInvocationResult(
    name: string,
    args: Record<string, unknown>,
    rawResult: string,
  ): string {
    const tool = this.tools.get(name);
    const adapter = tool ? displayAdapter(tool) : undefined;
    if (adapter) {
      try {
        const rendered = adapter.renderResult(rawResult, args);
        if (rendered && rendered.trim().length > 0) {
          return rendered;
        }
      } catch {
        // Fall through to raw preview
      }
    }
    const compact = rawResult.replace(/\s+/g, " ").trim();
    if (compact.length <= 120) return compact;
    return `${compact.slice(0, 120)}...`;
  }

  renderInvocationUse(
    name: string,
    args: Record<string, unknown>,
  ): string | null {
    const tool = this.tools.get(name);
    const adapter = tool ? displayAdapter(tool) : undefined;
    if (adapter) {
      try {
        return adapter.renderUse(args) ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Build a human-readable label for a specific tool invocation.
   */
  describeToolInvocation(name: string, args: Record<string, unknown>): string {
    const tool = this.tools.get(name);
    const customLabel = tool ? invocationLabel(tool, args) : undefined;

    if (customLabel && customLabel.trim().length > 0) {
      return customLabel;
    }

    return name;
  }
}

function displayAdapter(tool: PresentedTool) {
  return tool.getDisplayAdapter?.();
}

function invocationLabel(tool: PresentedTool, args: Record<string, unknown>) {
  return tool.getInvocationLabel?.(args);
}
