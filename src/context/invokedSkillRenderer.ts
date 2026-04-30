import type { InvokedSkillRecord } from "../skills/types.js";

function compact(text: string | undefined): string {
  return text ? text.replace(/\s+/g, " ").trim() : "";
}

export function renderInvokedSkillBlock(
  records: ReadonlyArray<InvokedSkillRecord>,
): string {
  if (records.length === 0) {
    return "";
  }

  const lines: string[] = ["<invoked_skills>"];

  for (const record of records) {
    const scope = record.scope;
    const headerParts = [
      `name: ${record.name}`,
      `source: ${record.source}`,
      `invocationSource: ${scope.invocationSource}`,
      `invokedAt: ${record.invokedAt}`,
    ];

    if (record.arguments) {
      headerParts.push(`arguments: ${compact(record.arguments)}`);
    }
    if (scope.allowedTools && scope.allowedTools.length > 0) {
      headerParts.push(`allowedTools: ${scope.allowedTools.join(", ")}`);
    }
    if (scope.model) {
      headerParts.push(`model: ${scope.model}`);
    }
    if (scope.effort) {
      headerParts.push(`effort: ${scope.effort}`);
    }
    if (scope.warnings && scope.warnings.length > 0) {
      headerParts.push(`warnings: ${scope.warnings.join(" | ")}`);
    }

    lines.push(`- ${headerParts.join(" | ")}`);
    if (record.content.trim().length > 0) {
      lines.push(`  ${record.content}`);
    }
  }

  lines.push("</invoked_skills>");
  return lines.join("\n");
}
