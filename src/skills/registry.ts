import type { SkillContext, Skill, SkillLoadDiagnostic } from "./types.js";

type SkillReloadFn = (context: SkillContext) => {
  readonly skills: Skill[];
  readonly diagnostics: SkillLoadDiagnostic[];
};
type SkillBodyLoader = (skillFile: string) => string;

function cloneSkill(skill: Skill): Skill {
  return {
    ...skill,
    ...(skill.arguments ? { arguments: [...skill.arguments] } : {}),
    ...(skill.allowedTools ? { allowedTools: [...skill.allowedTools] } : {}),
    ...(skill.paths ? { paths: [...skill.paths] } : {}),
  };
}

export class SkillRegistry {
  private skills: Skill[];
  private diagnostics: SkillLoadDiagnostic[];

  private constructor(
    private readonly context: SkillContext,
    skills: Skill[],
    diagnostics: SkillLoadDiagnostic[],
    private readonly reloadSkills: SkillReloadFn,
    private readonly loadSkillBody: SkillBodyLoader,
  ) {
    this.skills = skills;
    this.diagnostics = diagnostics;
  }

  static create(
    context: SkillContext,
    skills: Skill[],
    diagnostics: SkillLoadDiagnostic[],
    reloadSkills: SkillReloadFn,
    loadSkillBody: SkillBodyLoader,
  ): SkillRegistry {
    return new SkillRegistry(
      context,
      skills.map((skill) => cloneSkill(skill)),
      diagnostics.slice(),
      reloadSkills,
      loadSkillBody,
    );
  }

  setDiagnostics(diagnostics: SkillLoadDiagnostic[]): void {
    this.diagnostics = diagnostics.slice();
  }

  list(): ReadonlyArray<Skill> {
    return this.skills.map((skill) => cloneSkill(skill));
  }

  get(name: string): Skill | undefined {
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    const skill = this.skills.find((entry) => entry.name === normalized);
    return skill ? cloneSkill(skill) : undefined;
  }

  materialize(
    name: string,
    _invocation?: import("./types.js").SkillInvocation,
  ): string {
    const skill = this.get(name);
    if (!skill) {
      throw new Error(`Skill not found: ${name}`);
    }

    const body = this.loadSkillBody(skill.skillFile);
    const prefix = `Base directory for this skill: ${skill.skillRoot}`;
    return body.length > 0 ? `${prefix}\n${body}` : prefix;
  }

  refresh(): SkillLoadDiagnostic[] {
    const result = this.reloadSkills(this.context);
    this.skills = result.skills.map((skill) => cloneSkill(skill));
    this.diagnostics = result.diagnostics.slice();
    return this.diagnostics.slice();
  }

  getDiagnostics(): ReadonlyArray<SkillLoadDiagnostic> {
    return this.diagnostics.slice();
  }
}
