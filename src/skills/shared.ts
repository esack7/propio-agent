import type {
  InvokedSkillRecord,
  Skill,
  SkillLoadDiagnostic,
} from "./types.js";

export function createMissingSkillError(
  name: string,
  skills: ReadonlyArray<Skill>,
): Error {
  const availableSkills = skills
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const suffix =
    availableSkills.length > 0
      ? ` Available skills: ${availableSkills.join(", ")}`
      : "";

  return new Error(`Skill not found: ${name}.${suffix}`);
}

export function createSkillDiagnostic(
  severity: SkillLoadDiagnostic["severity"],
  code: string,
  message: string,
  skillPath?: string,
  skillName?: string,
): SkillLoadDiagnostic {
  return {
    severity,
    code,
    message,
    ...(skillPath ? { skillPath } : {}),
    ...(skillName ? { skillName } : {}),
  };
}

function cloneInvocationScope(
  scope: InvokedSkillRecord["scope"],
): InvokedSkillRecord["scope"] {
  return {
    ...scope,
    ...(scope.allowedTools ? { allowedTools: [...scope.allowedTools] } : {}),
    ...(scope.warnings ? { warnings: [...scope.warnings] } : {}),
  };
}

export function cloneInvokedSkillRecord(
  record: InvokedSkillRecord,
): InvokedSkillRecord {
  return {
    ...record,
    scope: cloneInvocationScope(record.scope),
  };
}
