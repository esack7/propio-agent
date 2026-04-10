import { ChatTool } from "../providers/types.js";

/**
 * ExecutableTool interface bundles tool schema and execution logic.
 *
 * Each tool implementation must expose:
 * - name: Unique tool identifier
 * - getSchema(): Returns the ChatTool schema for LLM consumption
 * - execute(args): Executes the tool logic and returns a string result
 *
 * The schema's function name must match the tool's name property.
 */
export interface ExecutableTool {
  /**
   * Unique tool identifier. Must match the function name in the schema.
   */
  readonly name: string;

  /**
   * Short human-readable summary used in menus and tool listings.
   */
  readonly description: string;

  /**
   * Returns the ChatTool schema for LLM consumption.
   * The schema defines the tool's function signature, description, and parameters.
   */
  getSchema(): ChatTool;

  /**
   * Optional human-readable label for a specific invocation.
   * Used by the interactive UI to render activity without parsing arguments.
   */
  getInvocationLabel?(args: Record<string, unknown>): string | undefined;

  /**
   * Executes the tool logic with the provided arguments.
   * @param args - Tool arguments as a key-value record
   * @returns Promise resolving to string result from tool execution
   * @throws Error if execution fails
   */
  execute(args: Record<string, unknown>): Promise<string>;
}
