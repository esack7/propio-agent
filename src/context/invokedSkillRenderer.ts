import type { InvokedSkillRecord } from "../skills/types.js";

function compact(text: string | undefined): string {
  return text ? text.replace(/\s+/g, " ").trim() : "";
}

function buildSkillHeaderParts(record: InvokedSkillRecord): string[] {
  const scope = record.scope;
  const parts = [
    `name: ${record.name}`,
    `source: ${record.source}`,
    `invocationSource: ${scope.invocationSource}`,
    `invokedAt: ${record.invokedAt}`,
  ];

  const optionalParts: Array<[unknown, string]> = [
    [record.arguments, `arguments: ${compact(record.arguments)}`],
    [scope.model, `model: ${scope.model}`],
    [scope.effort, `effort: ${scope.effort}`],
  ];
  for (const [value, text] of optionalParts) {
    if (value) parts.push(text);
  }
  if (scope.allowedTools?.length) {
    parts.push(`allowedTools: ${scope.allowedTools.join(", ")}`);
  }
  if (scope.warnings?.length) {
    parts.push(`warnings: ${scope.warnings.join(" | ")}`);
  }

  return parts;
}

function appendSkillRecord(lines: string[], record: InvokedSkillRecord): void {
  lines.push(`- ${buildSkillHeaderParts(record).join(" | ")}`);
  if (record.content.trim()) {
    lines.push(`  ${record.content}`);
  }
}

export function renderInvokedSkillBlock(
  records: ReadonlyArray<InvokedSkillRecord>,
): string {
  if (records.length === 0) {
    return "";
  }

  const lines: string[] = ["<invoked_skills>"];

  for (const record of records) {
    appendSkillRecord(lines, record);
  }

  lines.push("</invoked_skills>");
  return lines.join("\n");
}
