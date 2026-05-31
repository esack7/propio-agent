import { ToolRegistry } from "./registry.js";
import { createBuiltinToolManifest } from "./manifest.js";
import type { SkillToolInvoker } from "./skill.js";
import type { RuntimeConfig } from "../config/runtimeConfig.js";
import type { BashGlobalInstallGateConfig } from "./bash.js";

/**
 * Creates a ToolRegistry pre-loaded with the built-in 7-tool surface.
 */
export function createDefaultToolRegistry(options?: {
  readonly skillToolInvoker: SkillToolInvoker;
  readonly runtimeConfig?: RuntimeConfig;
  readonly bashGlobalInstallGate?: BashGlobalInstallGateConfig;
}): ToolRegistry {
  const registry = new ToolRegistry();

  for (const definition of createBuiltinToolManifest({
    skillToolInvoker: options?.skillToolInvoker ?? {
      async invokeSkill(name: string): Promise<string> {
        throw new Error(`Skill tool invoker was not configured for ${name}.`);
      },
    },
    runtimeConfig: options?.runtimeConfig,
    bashGlobalInstallGate: options?.bashGlobalInstallGate,
  })) {
    registry.register(definition.tool, definition.enabledByDefault);
  }

  return registry;
}
