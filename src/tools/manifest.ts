import { createLocalToolDefinitions } from "./localTools.js";
import { executeNodeShell } from "./nodeShell.js";
import { SkillTool, type SkillToolInvoker } from "./skill.js";
import type { PresentedTool } from "./interface.js";
import type { RuntimeConfig } from "../config/runtimeConfig.js";

export interface BuiltinToolDefinition {
  tool: PresentedTool;
  enabledByDefault: boolean;
}

export interface BuiltinToolManifestOptions {
  readonly skillToolInvoker: SkillToolInvoker;
  readonly runtimeConfig?: RuntimeConfig;
}

export function createBuiltinToolManifest(
  options: BuiltinToolManifestOptions,
): ReadonlyArray<BuiltinToolDefinition> {
  const config = options.runtimeConfig;
  const toolOutputInlineLimit = config?.toolOutputInlineLimit ?? 50 * 1024;

  return [
    ...createLocalToolDefinitions({
      workspaceRoot: process.cwd(),
      shellExecutor: executeNodeShell,
      outputInlineLimit: toolOutputInlineLimit,
      shell: {
        defaultTimeoutMs: config?.bashDefaultTimeoutMs,
        maxTimeoutMs: config?.bashMaxTimeoutMs,
      },
    }),
    { tool: new SkillTool(options.skillToolInvoker), enabledByDefault: true },
  ];
}
