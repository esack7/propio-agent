import { ToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_MANIFEST } from "./manifest.js";

/**
 * Creates a ToolRegistry pre-loaded with the built-in 7-tool surface.
 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  for (const definition of BUILTIN_TOOL_MANIFEST) {
    registry.register(definition.tool, definition.enabledByDefault);
  }

  return registry;
}
