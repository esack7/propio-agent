import { BashTool } from "./bash.js";
import { EditTool } from "./edit.js";
import { FindTool } from "./find.js";
import { GrepTool } from "./grep.js";
import { LsTool } from "./ls.js";
import { ReadTool } from "./read.js";
import { SkillTool, type SkillToolInvoker } from "./skill.js";
import { WriteTool } from "./write.js";
import { ExecutableTool } from "./interface.js";
import type { RuntimeConfig } from "../config/runtimeConfig.js";

export interface BuiltinToolDefinition {
  tool: ExecutableTool;
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
    {
      tool: new ReadTool({ outputInlineLimit: toolOutputInlineLimit }),
      enabledByDefault: true,
    },
    { tool: new WriteTool(), enabledByDefault: true },
    { tool: new EditTool(), enabledByDefault: true },
    {
      tool: new BashTool({
        defaultTimeoutMs: config?.bashDefaultTimeoutMs,
        maxTimeoutMs: config?.bashMaxTimeoutMs,
        outputInlineLimit: toolOutputInlineLimit,
      }),
      enabledByDefault: true,
    },
    {
      tool: new GrepTool({ outputInlineLimit: toolOutputInlineLimit }),
      enabledByDefault: false,
    },
    { tool: new FindTool(), enabledByDefault: false },
    { tool: new LsTool(), enabledByDefault: false },
    { tool: new SkillTool(options.skillToolInvoker), enabledByDefault: true },
  ];
}
