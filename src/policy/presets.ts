import type { PermissionMode } from "./modes.js";

/** A name for a permission mode plus rules. User rules are layered on top. */
export interface PermissionPreset {
  readonly name: string;
  readonly description: string;
  readonly mode: PermissionMode;
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
}

export const DEFAULT_PRESET_NAME = "ask";

function freezePreset(preset: PermissionPreset): PermissionPreset {
  return Object.freeze({
    ...preset,
    allow: Object.freeze([...preset.allow]),
    ask: Object.freeze([...preset.ask]),
    deny: Object.freeze([...preset.deny]),
  });
}

/**
 * Frozen all the way down: callers receive these objects directly, and a
 * change through one would alter every engine loaded afterwards.
 */
const PRESETS: readonly PermissionPreset[] = Object.freeze(
  (
    [
      {
        name: "read-only",
        description:
          "Reads only. Writes, commands, and external tools are denied.",
        mode: "ask",
        allow: [],
        ask: [],
        deny: [
          "capability:workspace_write",
          "capability:process",
          "capability:network",
          "capability:external",
        ],
      },
      {
        name: "ask",
        description: "Reads inside the workspace run; everything else asks.",
        mode: "ask",
        allow: [],
        ask: [],
        deny: [],
      },
      {
        name: "accept-edits",
        description:
          "Reads and writes inside the workspace run; everything else asks.",
        mode: "accept-edits",
        allow: [],
        ask: [],
        deny: [],
      },
      {
        name: "bypass",
        description: "Every call runs unless a rule denies or asks.",
        mode: "bypass",
        allow: [],
        ask: [],
        deny: [],
      },
    ] satisfies PermissionPreset[]
  ).map(freezePreset),
);

export function listPresets(): readonly PermissionPreset[] {
  return PRESETS;
}

export function getPreset(name: string): PermissionPreset | undefined {
  return PRESETS.find((preset) => preset.name === name);
}
