import type { Agent } from "../agent.js";
import type { Skill, SkillLoadDiagnostic } from "../skills/types.js";
import type { TerminalUi } from "./terminal.js";

const SOURCE_ORDER: Skill["source"][] = [
  "project",
  "user",
  "bundled",
  "plugin",
  "mcp",
];

function formatSkillLine(skill: Skill, active: boolean): string {
  const tags: string[] = [skill.source];
  if (!active) {
    tags.push("dormant");
  }
  if (skill.userInvocable === false) {
    tags.push("user-off");
  }
  if (skill.disableModelInvocation === true) {
    tags.push("model-off");
  }
  const whenToUse = skill.whenToUse
    ? ` | ${skill.whenToUse.replace(/\s+/g, " ").trim()}`
    : "";
  return `  ${skill.name} [${tags.join(", ")}] - ${skill.description}${whenToUse}`;
}

function formatDiagnosticLine(diagnostic: SkillLoadDiagnostic): string {
  const prefix =
    diagnostic.severity === "error"
      ? "ERROR"
      : diagnostic.severity === "warning"
        ? "WARN"
        : "INFO";
  return `  [${prefix}] ${diagnostic.message}`;
}

export function showSkillsMenu(
  agent: Pick<
    Agent,
    | "refreshSkills"
    | "getSkillDiagnostics"
    | "listSkills"
    | "listUserInvocableSkills"
    | "listModelInvocableSkills"
  >,
  ui: Pick<TerminalUi, "command" | "error" | "info" | "section" | "subtle">,
): void {
  const diagnostics = agent.refreshSkills();
  const allSkills = agent.listSkills();
  const activeNames = new Set([
    ...agent.listUserInvocableSkills().map((skill) => skill.name),
    ...agent.listModelInvocableSkills().map((skill) => skill.name),
  ]);

  ui.section("Skills");
  ui.subtle(
    "Loaded skills are grouped by source. Future source groups are shown even when empty.",
  );

  for (const source of SOURCE_ORDER) {
    const sourceSkills = allSkills.filter((skill) => skill.source === source);
    ui.info(`Source: ${source} (${sourceSkills.length})`);

    if (sourceSkills.length === 0) {
      ui.subtle("  (none)");
      continue;
    }

    for (const skill of sourceSkills) {
      ui.command(formatSkillLine(skill, activeNames.has(skill.name)));
    }
  }

  const reloadDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.severity !== "info",
  );
  if (reloadDiagnostics.length > 0) {
    ui.section("Reload diagnostics");
    for (const diagnostic of reloadDiagnostics) {
      if (diagnostic.severity === "error") {
        ui.error(formatDiagnosticLine(diagnostic));
      } else {
        ui.info(formatDiagnosticLine(diagnostic));
      }
    }
  }

  ui.command("");
}
