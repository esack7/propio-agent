import { ToolRegistry } from "./registry";
import { ToolContext } from "./types";
import { ReadFileTool, WriteFileTool, ListDirTool, MkdirTool, RemoveTool, MoveTool } from "./fileSystem";
import { SaveSessionContextTool } from "./sessionContext";
import { SearchTextTool, SearchFilesTool } from "./search";
import { RunBashTool } from "./bash";

/**
 * Creates a ToolRegistry pre-loaded with all built-in tools.
 *
 * The factory encapsulates the default tool setup, making it ergonomic for
 * Agent to initialize with standard tools while still allowing advanced users
 * to create custom registries.
 *
 * All tools are registered and enabled by default except for `remove` and `run_bash`,
 * which are disabled due to their destructive potential. Users must explicitly
 * enable these tools via `registry.enable("remove")` or `registry.enable("run_bash")`.
 *
 * @param context - ToolContext with property getters for live agent state
 * @returns ToolRegistry with 10 built-in tools registered (8 enabled, 2 disabled)
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

  // Register all built-in tools
  registry.register(new ReadFileTool());
  registry.register(new WriteFileTool());
  registry.register(new SaveSessionContextTool(context));
  registry.register(new ListDirTool());
  registry.register(new MkdirTool());
  registry.register(new RemoveTool());
  registry.register(new MoveTool());
  registry.register(new SearchTextTool());
  registry.register(new SearchFilesTool());
  registry.register(new RunBashTool());

  // Disable destructive tools by default
  registry.disable("remove");
  registry.disable("run_bash");

  return registry;
}
