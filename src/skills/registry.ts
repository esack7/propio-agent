import * as path from "path";
import { minimatch } from "minimatch";
import type {
  InvokedSkillRecord,
  Skill,
  SkillContext,
  SkillInvocation,
  SkillInvocationSource,
  SkillLoadDiagnostic,
} from "./types.js";
import { createMissingSkillError } from "./shared.js";
import {
  createSkillDiagnostic as createDiagnostic,
  cloneInvokedSkillRecord,
} from "./shared.js";

type SkillReloadFn = (context: SkillContext) => {
  readonly skills: Skill[];
  readonly diagnostics: SkillLoadDiagnostic[];
};
type SkillBodyLoader = (skillFile: string) => string;
type SkillMaterializationWarningSink = (message: string) => void;

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

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
}

function pathMatchesGlob(candidate: string, pattern: string): boolean {
  return minimatch(candidate, pattern.replace(/\\/g, "/"), {
    dot: true,
    nobrace: false,
    nocase: false,
    noext: false,
    nonegate: false,
    nocomment: true,
  });
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

interface InvocationParseState {
  current: string;
  positional: string[];
  quote: "'" | '"' | null;
  escaped: boolean;
}

function createInvocationParseState(): InvocationParseState {
  return {
    current: "",
    positional: [],
    quote: null,
    escaped: false,
  };
}

function flushInvocationParseState(state: InvocationParseState): void {
  if (state.current.length > 0) {
    state.positional.push(state.current);
    state.current = "";
  }
}

function consumeInvocationArgumentCharacter(
  state: InvocationParseState,
  character: string,
): void {
  if (state.escaped) {
    state.current += character;
    state.escaped = false;
    return;
  }

  if (character === "\\") {
    state.escaped = true;
    return;
  }

  if (state.quote) {
    if (character === state.quote) {
      state.quote = null;
    } else {
      state.current += character;
    }
    return;
  }

  if (character === "'" || character === '"') {
    state.quote = character;
    return;
  }

  if (/\s/.test(character)) {
    flushInvocationParseState(state);
    return;
  }

  state.current += character;
}

interface PlaceholderResolution {
  readonly value: string;
  readonly consumed: boolean;
  readonly unknown: boolean;
}

function resolveIndexedPlaceholder(
  token: string,
  positionalArguments: string[],
): PlaceholderResolution | null {
  if (!/^\d+$/.test(token)) {
    return null;
  }

  const index = Number(token);
  if (index >= 0 && index < positionalArguments.length) {
    return {
      value: positionalArguments[index] ?? "",
      consumed: true,
      unknown: false,
    };
  }

  return { value: "", consumed: false, unknown: false };
}

function resolveNamedPlaceholder(
  token: string,
  positionalArguments: string[],
  skillArguments: ReadonlyArray<string>,
  placeholderNames: ReadonlySet<string>,
): PlaceholderResolution | null {
  if (!placeholderNames.has(token)) {
    return null;
  }

  const index = skillArguments.indexOf(token);
  if (index >= 0 && index < positionalArguments.length) {
    return {
      value: positionalArguments[index] ?? "",
      consumed: true,
      unknown: false,
    };
  }

  return { value: "", consumed: false, unknown: false };
}

function resolvePlaceholderValue(
  token: string,
  match: string,
  rawArguments: string,
  positionalArguments: string[],
  skillArguments: ReadonlyArray<string>,
  placeholderNames: ReadonlySet<string>,
): PlaceholderResolution {
  if (token === "ARGUMENTS") {
    return { value: rawArguments, consumed: true, unknown: false };
  }

  const indexed = resolveIndexedPlaceholder(token, positionalArguments);
  if (indexed) {
    return indexed;
  }

  const named = resolveNamedPlaceholder(
    token,
    positionalArguments,
    skillArguments,
    placeholderNames,
  );
  if (named) {
    return named;
  }

  return { value: match, consumed: false, unknown: true };
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
      diagnostics,
      reloadSkills,
      loadSkillBody,
    );
  }

  list(): ReadonlyArray<Skill> {
    return this.skills.map((skill) => cloneSkill(skill));
  }

  // fallow-ignore-next-line unused-class-member
  listUserInvocable(): ReadonlyArray<Skill> {
    return Array.from(this.activeSkillsByName.values())
      .filter((skill) => skill.userInvocable !== false)
      .map((skill) => cloneSkill(skill));
  }

  // fallow-ignore-next-line unused-class-member
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

  private getSkillOrThrow(name: string): Skill {
    const skill = this.get(name);
    if (!skill) {
      throw createMissingSkillError(name, this.list());
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

    const state = createInvocationParseState();
    for (const character of rawArguments) {
      consumeInvocationArgumentCharacter(state, character);
    }

    flushInvocationParseState(state);

    return { rawArguments, positional: state.positional };
  }

  private substituteMaterializedBody(
    skill: Skill,
    body: string,
    rawArguments: string,
    positionalArguments: string[],
    onWarning?: SkillMaterializationWarningSink,
  ): { content: string; consumedPlaceholder: boolean } {
    const placeholderNames = new Set(skill.arguments ?? []);
    let consumedPlaceholder = false;

    const substituted = body.replace(
      /\$(ARGUMENTS|\d+|[A-Za-z_][A-Za-z0-9_-]*)/g,
      (match, token: string) => {
        const resolution = resolvePlaceholderValue(
          token,
          match,
          rawArguments,
          positionalArguments,
          skill.arguments ?? [],
          placeholderNames,
        );
        if (resolution.consumed) {
          consumedPlaceholder = true;
        }
        if (resolution.unknown) {
          const diagnostic = createDiagnostic(
            "warning",
            "unknown_placeholder",
            `Unknown placeholder "${match}" in ${skill.skillFile}.`,
            skill.skillFile,
            skill.name,
          );
          this.diagnostics.push(diagnostic);
          onWarning?.(`Unknown placeholder "${match}" in ${skill.skillFile}.`);
        }
        return resolution.value;
      },
    );

    return { content: substituted, consumedPlaceholder };
  }

  // fallow-ignore-next-line unused-class-member
  materialize(
    name: string,
    invocation?: SkillInvocation,
    options?: { readonly onWarning?: SkillMaterializationWarningSink },
  ): string {
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
      options?.onWarning,
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

  // fallow-ignore-next-line unused-class-member
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

  // fallow-ignore-next-line unused-class-member
  recordInvocation(record: InvokedSkillRecord): void {
    this.invokedSkills.push(cloneInvokedSkillRecord(record));
  }

  // fallow-ignore-next-line unused-class-member
  refresh(): SkillLoadDiagnostic[] {
    const result = this.reloadSkills(this.context);
    this.skills = result.skills.map((skill) => cloneSkill(skill));
    this.diagnostics = result.diagnostics.slice();
    this.recomputeActivationState();
    return this.diagnostics.slice();
  }

  // fallow-ignore-next-line unused-class-member
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
        patterns.some((pattern) =>
          pathMatchesGlob(touchedPath, pattern.replace(/\\/g, "/")),
        ),
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
