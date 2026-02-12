import { ExecutableTool } from "./interface.js";
import { ChatTool } from "../providers/types.js";

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
  /** Stores tools indexed by name, preserving insertion order via Map */
  private tools: Map<string, ExecutableTool> = new Map();

  /** Tracks which tools are currently enabled */
  private enabledTools: Set<string> = new Set();

  /**
   * Register a tool and enable it by default.
   *
   * @param tool - The ExecutableTool to register
   */
  register(tool: ExecutableTool): void {
    this.tools.set(tool.name, tool);
    this.enabledTools.add(tool.name);
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
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);

    if (!tool) {
      return `Tool not found: ${name}`;
    }

    if (!this.enabledTools.has(name)) {
      return `Tool not available: ${name}`;
    }

    try {
      return await tool.execute(args);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `Error executing ${name}: ${errorMessage}`;
    }
  }
}
