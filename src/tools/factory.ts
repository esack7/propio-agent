import { ToolRegistry } from "./registry";
import { ToolContext } from "./types";
import { ReadFileTool, WriteFileTool } from "./fileSystem";
import { SaveSessionContextTool } from "./sessionContext";

/**
 * Creates a ToolRegistry pre-loaded with the three built-in tools.
 *
 * The factory encapsulates the default tool setup, making it ergonomic for
 * Agent to initialize with standard tools while still allowing advanced users
 * to create custom registries.
 *
 * @param context - ToolContext with property getters for live agent state
 * @returns ToolRegistry with read_file, write_file, and save_session_context tools registered and enabled
 *
 * @example
 * // Default case (in Agent constructor)
 * this.toolRegistry = createDefaultToolRegistry(toolContext);
 *
 * @example
 * // Advanced case (custom tools)
 * const registry = new ToolRegistry();
 * registry.register(new CustomTool());
 */
export function createDefaultToolRegistry(context: ToolContext): ToolRegistry {
  const registry = new ToolRegistry();

  // Register all three built-in tools
  registry.register(new ReadFileTool());
  registry.register(new WriteFileTool());
  registry.register(new SaveSessionContextTool(context));

  return registry;
}
