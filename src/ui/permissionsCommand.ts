import type {
  PermissionsOverview,
  ToolPermissions,
} from "../permissions/toolPermissions.js";
import {
  isPermissionMode,
  listPresets,
  PERMISSION_MODES,
  type RuleEffect,
} from "../policy/index.js";
import type { TerminalUi } from "./terminal.js";
import { visibleText } from "./visibleText.js";

type PermissionsUi = Pick<
  TerminalUi,
  "command" | "error" | "info" | "section" | "success"
>;

type Permissions = Pick<
  ToolPermissions,
  | "overview"
  | "addRule"
  | "removeRule"
  | "revokeSessionGrant"
  | "setPreset"
  | "setMode"
>;

const USAGE = [
  "Usage: /permissions",
  "       /permissions allow <rule> | ask <rule> | deny <rule>",
  "       /permissions remove <rule>",
  "       /permissions revoke <session grant>",
  `       /permissions preset <${listPresets()
    .map((preset) => preset.name)
    .join(" | ")}>`,
  `       /permissions mode <${PERMISSION_MODES.join(" | ")}>`,
];

const EFFECTS: readonly RuleEffect[] = ["deny", "ask", "allow"];
const SOURCE_LABELS = { preset: "preset", user: "settings" } as const;

function ruleLines(overview: PermissionsOverview): string[] {
  const stored = overview.rules.filter((rule) => rule.source !== "session");
  if (stored.length === 0) return ["  (no rules)"];
  return EFFECTS.flatMap((effect) =>
    stored
      .filter((rule) => rule.effect === effect)
      .map(
        (rule) =>
          `  ${effect.padEnd(5)} ${visibleText(rule.rule)}  (${
            SOURCE_LABELS[rule.source as keyof typeof SOURCE_LABELS]
          })`,
      ),
  );
}

function lastDecisionLine(overview: PermissionsOverview): string {
  const last = overview.lastDecision;
  if (!last) return "  (no tool call has been decided yet)";
  const outcome = last.allowed ? "allowed" : "denied";
  return `  ${visibleText(last.toolName)} ${outcome} by ${visibleText(last.rule)} (${last.actor})`;
}

function showOverview(overview: PermissionsOverview, ui: PermissionsUi): void {
  ui.section("Permissions");
  ui.command(`  preset: ${overview.preset}    mode: ${overview.mode}`);
  ui.section("Rules");
  for (const line of ruleLines(overview)) ui.command(line);
  ui.section("Session grants");
  if (overview.sessionGrants.length === 0) ui.command("  (none)");
  for (const grant of overview.sessionGrants) {
    ui.command(`  allow ${visibleText(grant)}`);
  }
  ui.section("Last decision");
  ui.command(lastDecisionLine(overview));
  ui.command("");
}

function showUsage(ui: PermissionsUi): void {
  for (const line of USAGE) ui.command(line);
  ui.command("");
}

type Subcommand = (
  argument: string,
  permissions: Permissions,
  ui: PermissionsUi,
) => Promise<boolean>;

function saveRule(effect: RuleEffect): Subcommand {
  return async (argument, permissions, ui) => {
    await permissions.addRule(effect, argument);
    ui.success(`Saved ${effect} rule ${visibleText(argument)}.`);
    return true;
  };
}

/** Each returns false when the argument is not one it accepts. */
const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
  allow: saveRule("allow"),
  ask: saveRule("ask"),
  deny: saveRule("deny"),
  remove: async (argument, permissions, ui) => {
    if (await permissions.removeRule(argument)) {
      ui.success(`Removed rule ${visibleText(argument)}.`);
    } else {
      ui.error(`No stored rule ${visibleText(argument)}.`);
    }
    return true;
  },
  revoke: async (argument, permissions, ui) => {
    if (await permissions.revokeSessionGrant(argument)) {
      ui.success(`Revoked session grant ${visibleText(argument)}.`);
    } else {
      ui.error(`No session grant ${visibleText(argument)}.`);
    }
    return true;
  },
  preset: async (argument, permissions, ui) => {
    await permissions.setPreset(argument);
    ui.success(`Using the ${argument} preset for this session.`);
    return true;
  },
  mode: async (argument, permissions, ui) => {
    if (!isPermissionMode(argument)) return false;
    await permissions.setMode(argument);
    ui.success(`Permission mode is ${argument} for this session.`);
    return true;
  },
};

async function applySubcommand(
  subcommand: string,
  argument: string,
  permissions: Permissions,
  ui: PermissionsUi,
): Promise<boolean> {
  const apply = Object.prototype.hasOwnProperty.call(SUBCOMMANDS, subcommand)
    ? SUBCOMMANDS[subcommand]
    : undefined;
  return apply !== undefined && (await apply(argument, permissions, ui));
}

/** `/permissions`: show what is in force, or edit rules, grants, preset, and mode. */
export async function handlePermissionsCommand(
  input: string,
  permissions: Permissions,
  ui: PermissionsUi,
): Promise<void> {
  const rest = input.slice("/permissions".length).trim();
  try {
    if (rest === "") {
      showOverview(await permissions.overview(), ui);
      return;
    }
    const separator = rest.search(/\s/);
    const subcommand = separator < 0 ? rest : rest.slice(0, separator);
    const argument = separator < 0 ? "" : rest.slice(separator).trim();
    const handled =
      argument !== "" &&
      (await applySubcommand(subcommand, argument, permissions, ui));
    if (!handled) {
      ui.error(`Unknown /permissions usage: "${visibleText(rest)}"`);
      showUsage(ui);
      return;
    }
    ui.command("");
  } catch (error) {
    // A rule that cannot be read, an unknown preset, or a settings file that
    // could not be written: nothing was changed.
    ui.error(error instanceof Error ? error.message : String(error));
    ui.command("");
  }
}
