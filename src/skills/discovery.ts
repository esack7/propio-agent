import type { Skill } from "./types.js";

export const MAX_SKILL_DISCOVERY_CHARS = 3000;

function compact(text: string | undefined): string {
  return text ? text.replace(/\s+/g, " ").trim() : "";
}

function formatSkillEntry(skill: Skill): string {
  const parts = [
    `name: ${skill.name}`,
    `source: ${skill.source}`,
    `description: ${compact(skill.description)}`,
  ];

  const whenToUse = compact(skill.whenToUse);
  if (whenToUse) {
    parts.push(`whenToUse: ${whenToUse}`);
  }

  return `- ${parts.join(" | ")}`;
}

export function renderSkillDiscoveryBlock(
  skills: ReadonlyArray<Skill>,
): string {
  if (skills.length === 0) {
    return "";
  }

  const lines: string[] = ["<skills>"];
  let omittedCount = 0;

  for (const skill of skills) {
    const candidate = formatSkillEntry(skill);
    const nextLines = [...lines, candidate, "</skills>"];
    const nextText = nextLines.join("\n");
    if (nextText.length > MAX_SKILL_DISCOVERY_CHARS) {
      omittedCount += 1;
      continue;
    }
    lines.push(candidate);
  }

  if (omittedCount > 0) {
    const summary = `... ${omittedCount} more skill${omittedCount === 1 ? "" : "s"} omitted`;
    const nextText = [...lines, summary, "</skills>"].join("\n");
    if (nextText.length <= MAX_SKILL_DISCOVERY_CHARS) {
      lines.push(summary);
    }
  }

  lines.push("</skills>");
  return lines.join("\n");
}
