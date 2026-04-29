import * as path from "path";
import type {
  InvokedSkillRecord,
  Skill,
  SkillContext,
  SkillInvocation,
  SkillInvocationSource,
  SkillLoadDiagnostic,
} from "./types.js";

type SkillReloadFn = (context: SkillContext) => {
  readonly skills: Skill[];
  readonly diagnostics: SkillLoadDiagnostic[];
};
type SkillBodyLoader = (skillFile: string) => string;

const SKILL_SOURCE_ORDER: Record<Skill["source"], number> = {
  project: 0,
  user: 1,
  bundled: 2,
  plugin: 3,
  mcp: 4,
};

function cloneSkill(skill: Skill): Skill {
  return {
    ...skill,
    ...(skill.arguments ? { arguments: [...skill.arguments] } : {}),
    ...(skill.allowedTools ? { allowedTools: [...skill.allowedTools] } : {}),
    ...(skill.paths ? { paths: [...skill.paths] } : {}),
  };
}

function cloneInvokedSkill(record: InvokedSkillRecord): InvokedSkillRecord {
  return {
    ...record,
    ...(record.scope.allowedTools
      ? {
          scope: {
            ...record.scope,
            allowedTools: [...record.scope.allowedTools],
          },
        }
      : { scope: { ...record.scope } }),
    ...(record.scope.warnings
      ? {
          scope: {
            ...record.scope,
            warnings: [...record.scope.warnings],
            ...(record.scope.allowedTools
              ? { allowedTools: [...record.scope.allowedTools] }
              : {}),
          },
        }
      : {}),
  };
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  const escaped = escapeRegExp(normalized)
    .replace(/\\\*\\\*/g, ".*")
    .replace(/\\\*/g, "[^/]*")
    .replace(/\\\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function isPathIgnored(candidate: string): boolean {
  const parts = candidate.split("/");
  return parts.some((part) =>
    ["dist", "node_modules", ".git", "coverage"].includes(part),
  );
}

function compareSkills(a: Skill, b: Skill): number {
  if (a.source !== b.source) {
    return SKILL_SOURCE_ORDER[a.source] - SKILL_SOURCE_ORDER[b.source];
  }

  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) {
    return byName;
  }

  return a.skillFile.localeCompare(b.skillFile);
}

function hasPathActivation(skill: Skill): boolean {
  return Array.isArray(skill.paths) && skill.paths.length > 0;
}

function skillDepth(skill: Skill): number {
  return normalizePath(skill.skillRoot).split("/").length;
}

export class SkillRegistry {
  private skills: Skill[];
  private diagnostics: SkillLoadDiagnostic[];
  private activeSkillNames: Set<string>;
  private activeSkillsByName: Map<string, Skill>;
  private touchedPaths: string[] = [];
  private invokedSkills: InvokedSkillRecord[] = [];

  private constructor(
    private readonly context: SkillContext,
    skills: Skill[],
    diagnostics: SkillLoadDiagnostic[],
    private readonly reloadSkills: SkillReloadFn,
    private readonly loadSkillBody: SkillBodyLoader,
  ) {
    this.skills = skills;
    this.diagnostics = diagnostics;
    this.activeSkillNames = new Set();
    this.activeSkillsByName = new Map();
    this.recomputeActivationState();
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

  listUserInvocable(): ReadonlyArray<Skill> {
    return Array.from(this.activeSkillsByName.values())
      .filter((skill) => skill.userInvocable !== false)
      .map((skill) => cloneSkill(skill));
  }

  listModelInvocable(): ReadonlyArray<Skill> {
    return Array.from(this.activeSkillsByName.values())
      .filter((skill) => skill.disableModelInvocation !== true)
      .map((skill) => cloneSkill(skill));
  }

  get(name: string): Skill | undefined {
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    const activeSkill = this.activeSkillsByName.get(normalized);
    if (activeSkill) {
      return cloneSkill(activeSkill);
    }

    const skill = this.skills.find((entry) => entry.name === normalized);
    return skill ? cloneSkill(skill) : undefined;
  }

  isSkillActive(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return normalized.length > 0 && this.activeSkillNames.has(normalized);
  }

  private getSkillOrThrow(name: string): Skill {
    const skill = this.get(name);
    if (!skill) {
      throw new Error(`Skill not found: ${name}`);
    }
    return skill;
  }

  private renderArgumentsMetadata(skill: Skill): string {
    const namedArguments = skill.arguments ?? [];
    if (namedArguments.length === 0) {
      return "";
    }
    return `ARGUMENTS META: ${namedArguments.join(", ")}`;
  }

  private parseInvocationArguments(invocation?: SkillInvocation): {
    readonly rawArguments: string;
    readonly positional: string[];
  } {
    const rawArguments = invocation?.arguments?.trim() ?? "";
    if (!rawArguments) {
      return { rawArguments: "", positional: [] };
    }

    const positional: string[] = [];
    let current = "";
    let quote: "'" | '"' | null = null;
    let escaped = false;

    for (const character of rawArguments) {
      if (escaped) {
        current += character;
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (quote) {
        if (character === quote) {
          quote = null;
        } else {
          current += character;
        }
        continue;
      }

      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }

      if (/\s/.test(character)) {
        if (current.length > 0) {
          positional.push(current);
          current = "";
        }
        continue;
      }

      current += character;
    }

    if (current.length > 0) {
      positional.push(current);
    }

    return { rawArguments, positional };
  }

  private substituteMaterializedBody(
    skill: Skill,
    body: string,
    rawArguments: string,
    positionalArguments: string[],
  ): { content: string; consumedPlaceholder: boolean } {
    const placeholderNames = new Set(skill.arguments ?? []);
    let consumedPlaceholder = false;

    const substituted = body.replace(
      /\$(ARGUMENTS|\d+|[A-Za-z_][A-Za-z0-9_-]*)/g,
      (match, token: string) => {
        if (token === "ARGUMENTS") {
          consumedPlaceholder = true;
          return rawArguments;
        }

        if (/^\d+$/.test(token)) {
          const index = Number(token);
          if (index >= 0 && index < positionalArguments.length) {
            consumedPlaceholder = true;
            return positionalArguments[index] ?? "";
          }
          return "";
        }

        if (placeholderNames.has(token)) {
          const index = (skill.arguments ?? []).indexOf(token);
          if (index >= 0 && index < positionalArguments.length) {
            consumedPlaceholder = true;
            return positionalArguments[index] ?? "";
          }
          return "";
        }

        return match;
      },
    );

    return { content: substituted, consumedPlaceholder };
  }

  materialize(name: string, invocation?: SkillInvocation): string {
    const skill = this.getSkillOrThrow(name);

    const body = this.loadSkillBody(skill.skillFile);
    const prefix = `Base directory for this skill: ${skill.skillRoot}`;
    const { rawArguments, positional } =
      this.parseInvocationArguments(invocation);
    const { content, consumedPlaceholder } = this.substituteMaterializedBody(
      skill,
      body,
      rawArguments,
      positional,
    );

    const sections: string[] = [prefix];
    const metadataLine = this.renderArgumentsMetadata(skill);
    if (metadataLine) {
      sections.push(metadataLine);
    }
    if (content.length > 0) {
      sections.push(content);
    }
    if (rawArguments && !consumedPlaceholder) {
      sections.push(`ARGUMENTS: ${rawArguments}`);
    }

    return sections.join("\n");
  }

  recordFileTouch(paths: readonly string[]): ReadonlyArray<Skill> {
    const cwd = path.resolve(this.context.cwd);
    const touched = paths
      .map((entry) =>
        path.relative(cwd, path.resolve(entry)).replace(/\\/g, "/"),
      )
      .filter(
        (entry) =>
          entry.length > 0 && !entry.startsWith("..") && !isPathIgnored(entry),
      );

    if (touched.length === 0) {
      return [];
    }

    this.touchedPaths.push(...touched);
    const activated = this.recomputeActivationState();
    return activated.map((skill) => cloneSkill(skill));
  }

  recordInvocation(record: InvokedSkillRecord): void {
    this.invokedSkills.push(cloneInvokedSkill(record));
  }

  listInvocations(): ReadonlyArray<InvokedSkillRecord> {
    return this.invokedSkills.map((record) => cloneInvokedSkill(record));
  }

  refresh(): SkillLoadDiagnostic[] {
    const result = this.reloadSkills(this.context);
    this.skills = result.skills.map((skill) => cloneSkill(skill));
    this.diagnostics = result.diagnostics.slice();
    this.recomputeActivationState();
    return this.diagnostics.slice();
  }

  getDiagnostics(): ReadonlyArray<SkillLoadDiagnostic> {
    return this.diagnostics.slice();
  }

  private recomputeActivationState(): Skill[] {
    const activeSkillNames = new Set<string>();
    const activatedByName = new Map<string, Skill>();

    for (const skill of this.skills) {
      if (!hasPathActivation(skill)) {
        activeSkillNames.add(skill.name);
        activatedByName.set(skill.name, skill);
        continue;
      }

      const patterns = skill.paths ?? [];
      const matches = this.touchedPaths.some((touchedPath) =>
        patterns.some((pattern) => globToRegExp(pattern).test(touchedPath)),
      );
      if (!matches) {
        continue;
      }

      activeSkillNames.add(skill.name);
      const existing = activatedByName.get(skill.name);
      if (!existing || skillDepth(skill) > skillDepth(existing)) {
        activatedByName.set(skill.name, skill);
      }
    }

    this.activeSkillNames = activeSkillNames;
    this.activeSkillsByName = activatedByName;
    this.skills.sort(compareSkills);
    return Array.from(activatedByName.values());
  }
}
