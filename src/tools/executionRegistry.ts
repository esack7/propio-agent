import {
  type ExecutableTool,
  type ToolExecutionContext,
  type ToolRegistryOptions,
} from "./execution.js";
import { ChatTool } from "@propio-ai/providers";
import { ToolExecutionResult } from "./types.js";

export interface ToolSummary {
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly enabledByDefault: boolean;
}

/**
 * ToolRegistry manages tool registration, lifecycle, and execution.
 *
 * Responsibilities:
 * - Register and unregister tools
 * - Enable and disable tools
 * - Provide tool schemas for LLM consumption
 * - Execute tools with error handling
 */
export class ToolRegistry {
  constructor(private readonly options: ToolRegistryOptions = {}) {}

  /** Stores tools indexed by name, preserving insertion order via Map */
  protected tools: Map<string, ExecutableTool> = new Map();

  /** Tracks which tools are currently enabled */
  private enabledTools: Set<string> = new Set();

  /** Tracks built-in or registration-time default state for each tool. */
  private enabledByDefault: Map<string, boolean> = new Map();

  /**
   * Register a tool and optionally enable it by default.
   *
   * @param tool - The ExecutableTool to register
   */
  register(tool: ExecutableTool, enabledByDefault = false): void {
    this.tools.set(tool.name, tool);
    this.enabledByDefault.set(tool.name, enabledByDefault);
    if (enabledByDefault) {
      this.enabledTools.add(tool.name);
    } else {
      this.enabledTools.delete(tool.name);
    }
  }

  /**
   * Unregister a tool (idempotent operation).
   *
   * Safely removes a tool even if it wasn't registered. Does not throw.
   *
   * @param name - The name of the tool to unregister
   */
  unregister(name: string): void {
    this.tools.delete(name);
    this.enabledTools.delete(name);
    this.enabledByDefault.delete(name);
  }

  /**
   * Enable a tool for execution and inclusion in schemas.
   *
   * @param name - The name of the tool to enable
   */
  enable(name: string): void {
    if (this.tools.has(name)) {
      this.enabledTools.add(name);
    }
  }

  /**
   * Disable a tool, preventing execution and excluding from schemas.
   *
   * @param name - The name of the tool to disable
   */
  disable(name: string): void {
    this.enabledTools.delete(name);
  }

  /** Enable all registered tools. */
  enableAll(): void {
    for (const toolName of this.tools.keys()) {
      this.enabledTools.add(toolName);
    }
  }

  /** Disable all registered tools. */
  disableAll(): void {
    this.enabledTools.clear();
  }

  /** Restore the registered tools to their manifest-time defaults. */
  resetToManifestDefaults(): void {
    this.enabledTools.clear();
    for (const [toolName, isEnabledByDefault] of this.enabledByDefault) {
      if (isEnabledByDefault) {
        this.enabledTools.add(toolName);
      }
    }
  }

  /**
   * Get schemas for all enabled tools in registration order.
   *
   * The returned array preserves the order in which tools were registered,
   * filtered to include only enabled tools.
   *
   * @returns Array of ChatTool schemas for enabled tools
   */
  getEnabledSchemas(): ChatTool[] {
    const schemas: ChatTool[] = [];

    // Iterate through registered tools in insertion order
    for (const [toolName, tool] of this.tools) {
      if (this.enabledTools.has(toolName)) {
        schemas.push(tool.getSchema());
      }
    }

    return schemas;
  }

  /**
   * Get names of all registered tools in registration order.
   *
   * Returns all tool names, both enabled and disabled.
   *
   * @returns Array of tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Return read-only summaries for the registered tools in registration order.
   */
  getToolSummaries(): ReadonlyArray<ToolSummary> {
    const summaries: ToolSummary[] = [];

    for (const [toolName, tool] of this.tools) {
      summaries.push({
        name: toolName,
        description: tool.description,
        enabled: this.enabledTools.has(toolName),
        enabledByDefault: this.enabledByDefault.get(toolName) ?? false,
      });
    }

    return summaries;
  }

  /**
   * Check if a tool is registered.
   *
   * @param name - The name of the tool to check
   * @returns true if the tool is registered, false otherwise
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Check if a tool is registered and enabled.
   *
   * @param name - The name of the tool to check
   * @returns true if the tool is registered and enabled, false otherwise
   */
  isToolEnabled(name: string): boolean {
    return this.tools.has(name) && this.enabledTools.has(name);
  }

  /**
   * Execute a tool with comprehensive error handling.
   *
   * Handles three error cases:
   * 1. Tool not registered: returns "Tool not found: {name}"
   * 2. Tool disabled: returns "Tool not available: {name}"
   * 3. Execution error: catches and returns "Error executing {name}: {error.message}"
   *
   * @param name - The name of the tool to execute
   * @param args - The arguments to pass to the tool
   * @returns Promise resolving to the string result from the tool, or an error message if execution fails
   */
  async executeWithStatus(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return { status: "tool_not_found", content: `Tool not found: ${name}` };
    }

    if (!this.enabledTools.has(name)) {
      return {
        status: "tool_disabled",
        content: `Tool not available: ${name}`,
      };
    }

    try {
      context.signal?.throwIfAborted();
      const executionArgs = this.options.approve
        ? cloneApprovalArgs(args)
        : args;
      const blocked = await this.checkExecutionPolicy(
        tool,
        executionArgs,
        context,
      );
      if (blocked) return blocked;
      const result = await this.executeAvailable(tool, executionArgs, context);
      return await this.processOutput(name, result);
    } catch (error) {
      return executionError(name, error, context);
    }
  }

  private async checkExecutionPolicy(
    tool: ExecutableTool,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult | undefined> {
    const name = tool.name;
    if (
      this.options.approve &&
      !(await this.options.approve(
        { name, args: structuredClone(args) },
        context,
      ))
    ) {
      context.signal?.throwIfAborted();
      return {
        status: "tool_disabled",
        content: `Tool execution denied: ${name}`,
      };
    }
    context.signal?.throwIfAborted();
    return undefined;
  }

  private async executeAvailable(
    tool: ExecutableTool,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    context.signal?.throwIfAborted();
    if (this.tools.get(tool.name) !== tool || !this.isToolEnabled(tool.name)) {
      return {
        status: "tool_disabled",
        content: `Tool not available: ${tool.name}`,
      };
    }
    return tool.executeWithStatus
      ? tool.executeWithStatus(args, context)
      : { status: "success", content: await tool.execute(args, context) };
  }

  private async processOutput(
    name: string,
    result: ToolExecutionResult,
  ): Promise<ToolExecutionResult> {
    if (!this.options.processOutput) return result;
    try {
      const output = await this.options.processOutput({
        name,
        result: { ...result },
      });
      return {
        ...result,
        content: output.content,
        externalStorage: output.externalStorage ?? result.externalStorage,
      };
    } catch (error) {
      // Execution has already completed. Retain its result so callers do not retry a write.
      return {
        ...result,
        outputPersistenceError:
          error instanceof Error ? error.message : String(error),
      };
    }
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const result = await this.executeWithStatus(name, args, context);
    return result.content;
  }
}

function executionError(
  name: string,
  error: unknown,
  context: ToolExecutionContext,
): ToolExecutionResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    status: "error",
    content: context.signal?.aborted
      ? `Tool execution cancelled: ${name}`
      : `Error executing ${name}: ${detail}`,
  };
}

function cloneApprovalArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return structuredClone(args);
  } catch {
    throw new Error(
      "Tool arguments must be structured-cloneable when approval is configured",
    );
  }
}
