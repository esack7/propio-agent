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
   * Returns the ChatTool schema for LLM consumption.
   * The schema defines the tool's function signature, description, and parameters.
   */
  getSchema(): ChatTool;

  /**
   * Executes the tool logic with the provided arguments.
   * @param args - Tool arguments as a key-value record
   * @returns Promise resolving to string result from tool execution
   * @throws Error if execution fails
   */
  execute(args: Record<string, unknown>): Promise<string>;
}
