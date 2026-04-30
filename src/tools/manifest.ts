import { BashTool } from "./bash.js";
import { EditTool } from "./edit.js";
import { FindTool } from "./find.js";
import { GrepTool } from "./grep.js";
import { LsTool } from "./ls.js";
import { ReadTool } from "./read.js";
import { SkillTool, type SkillToolInvoker } from "./skill.js";
import { WriteTool } from "./write.js";
import { ExecutableTool } from "./interface.js";

export interface BuiltinToolDefinition {
  tool: ExecutableTool;
  enabledByDefault: boolean;
}

export interface BuiltinToolManifestOptions {
  readonly skillToolInvoker: SkillToolInvoker;
}

export function createBuiltinToolManifest(
  options: BuiltinToolManifestOptions,
): ReadonlyArray<BuiltinToolDefinition> {
  return [
    { tool: new ReadTool(), enabledByDefault: true },
    { tool: new WriteTool(), enabledByDefault: true },
    { tool: new EditTool(), enabledByDefault: true },
    { tool: new BashTool(), enabledByDefault: true },
    { tool: new GrepTool(), enabledByDefault: false },
    { tool: new FindTool(), enabledByDefault: false },
    { tool: new LsTool(), enabledByDefault: false },
    { tool: new SkillTool(options.skillToolInvoker), enabledByDefault: true },
  ];
}

export const BUILTIN_TOOL_MANIFEST: ReadonlyArray<BuiltinToolDefinition> = [
  { tool: new ReadTool(), enabledByDefault: true },
  { tool: new WriteTool(), enabledByDefault: true },
  { tool: new EditTool(), enabledByDefault: true },
  { tool: new BashTool(), enabledByDefault: true },
  { tool: new GrepTool(), enabledByDefault: false },
  { tool: new FindTool(), enabledByDefault: false },
  { tool: new LsTool(), enabledByDefault: false },
];
