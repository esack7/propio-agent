import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseDocument } from "yaml";
import type {
  LoadLocalSkillsResult,
  Skill,
  SkillContext,
  SkillContextMode,
  SkillLoadDiagnostic,
  SkillMetadata,
  SkillSource,
} from "./types.js";
import { SkillRegistry } from "./registry.js";
import { createSkillDiagnostic as createDiagnostic } from "./shared.js";

const IGNORED_DIRECTORY_NAMES = new Set([
  "dist",
  "node_modules",
  ".git",
  "coverage",
]);

const ALLOWED_FIELD_NAMES = new Set([
  "name",
  "description",
  "when_to_use",
  "arguments",
  "argument-hint",
  "allowed-tools",
  "model",
  "effort",
  "disable-model-invocation",
  "user-invocable",
  "context",
  "agent",
  "paths",
  "version",
]);

const VALID_SKILL_NAME = /^[a-z0-9_:-]+$/;

interface ParsedSkillEntry {
  readonly skill?: Skill;
  readonly diagnostics: SkillLoadDiagnostic[];
}

interface LocalSkillScanResult {
  readonly skills: Skill[];
  readonly diagnostics: SkillLoadDiagnostic[];
}

interface FrontmatterNormalizationContext {
  readonly parsed: Record<string, unknown>;
  readonly diagnostics: SkillLoadDiagnostic[];
  readonly skillFile: string;
}

type MutableSkillMetadata = {
  -readonly [Key in keyof SkillMetadata]: SkillMetadata[Key];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAbsolutePath(value: string): string {
  return path.resolve(value);
}

function normalizeSkillName(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || !VALID_SKILL_NAME.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeStringField(
  value: unknown,
  fieldName: string,
  diagnostics: SkillLoadDiagnostic[],
  skillPath: string,
  options: { required?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "missing_required_field",
          `Missing required frontmatter field "${fieldName}" in ${skillPath}.`,
          skillPath,
        ),
      );
    }
    return undefined;
  }

  if (typeof value !== "string") {
    diagnostics.push(
      createDiagnostic(
        "error",
        "invalid_field_type",
        `Frontmatter field "${fieldName}" in ${skillPath} must be a string.`,
        skillPath,
      ),
    );
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    if (options.required) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "empty_required_field",
          `Frontmatter field "${fieldName}" in ${skillPath} cannot be empty.`,
          skillPath,
        ),
      );
    }
    return undefined;
  }

  return trimmed;
}

function normalizeBooleanField(
  value: unknown,
  fieldName: string,
  diagnostics: SkillLoadDiagnostic[],
  skillPath: string,
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    diagnostics.push(
      createDiagnostic(
        "error",
        "invalid_field_type",
        `Frontmatter field "${fieldName}" in ${skillPath} must be a boolean.`,
        skillPath,
      ),
    );
    return undefined;
  }
  return value;
}

function normalizeStringArrayField(
  value: unknown,
  fieldName: string,
  diagnostics: SkillLoadDiagnostic[],
  skillPath: string,
): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "invalid_field_type",
        `Frontmatter field "${fieldName}" in ${skillPath} must be an array of strings.`,
        skillPath,
      ),
    );
    return undefined;
  }

  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "invalid_field_type",
          `Frontmatter field "${fieldName}" in ${skillPath} must contain only non-empty strings.`,
          skillPath,
        ),
      );
      return undefined;
    }
    items.push(entry.trim());
  }

  return items;
}

function normalizeContextField(
  value: unknown,
  diagnostics: SkillLoadDiagnostic[],
  skillPath: string,
): SkillContextMode | undefined {
  const normalized = normalizeStringField(
    value,
    "context",
    diagnostics,
    skillPath,
  );
  if (!normalized) {
    return undefined;
  }

  if (normalized !== "inline" && normalized !== "fork") {
    diagnostics.push(
      createDiagnostic(
        "warning",
        "invalid_field_value",
        `Frontmatter field "context" in ${skillPath} must be "inline" or "fork".`,
        skillPath,
      ),
    );
    return undefined;
  }

  return normalized;
}

function parseFrontmatterRecord(
  frontmatterText: string,
  skillFile: string,
  diagnostics: SkillLoadDiagnostic[],
): Record<string, unknown> | null {
  const document = parseDocument(frontmatterText, { prettyErrors: true });
  if (document.errors.length > 0) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "malformed_frontmatter",
        `Failed to parse frontmatter in ${skillFile}: ${document.errors[0].message}`,
        skillFile,
      ),
    );
    return null;
  }

  const parsed = document.toJS();
  if (isPlainObject(parsed)) {
    return parsed;
  }

  diagnostics.push(
    createDiagnostic(
      "error",
      "invalid_frontmatter_shape",
      `Frontmatter in ${skillFile} must be a YAML mapping/object.`,
      skillFile,
    ),
  );
  return null;
}

function appendIgnoredFieldDiagnostics(
  context: FrontmatterNormalizationContext,
): void {
  for (const key of Object.keys(context.parsed)) {
    if (!ALLOWED_FIELD_NAMES.has(key)) {
      context.diagnostics.push(
        createDiagnostic(
          "info",
          "ignored_frontmatter_field",
          `Ignoring unsupported frontmatter field "${key}" in ${context.skillFile}.`,
          context.skillFile,
        ),
      );
    }
  }
}

function normalizeRequiredMetadata(
  context: FrontmatterNormalizationContext,
  directoryName: string,
): SkillMetadata | null {
  const { parsed, diagnostics, skillFile } = context;
  const description = normalizeStringField(
    parsed.description,
    "description",
    diagnostics,
    skillFile,
    { required: true },
  );
  const frontmatterName = normalizeStringField(
    parsed.name,
    "name",
    diagnostics,
    skillFile,
  );
  const name = normalizeSkillName(frontmatterName ?? directoryName);
  if (!name) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "invalid_skill_name",
        `Invalid skill name in ${skillFile}. Skill names must use letters, numbers, "_", "-", and ":".`,
        skillFile,
        frontmatterName ?? directoryName,
      ),
    );
    return null;
  }

  return description ? { name, description } : null;
}

function assignDefined<Key extends keyof SkillMetadata>(
  metadata: MutableSkillMetadata,
  key: Key,
  value: SkillMetadata[Key] | undefined,
): void {
  if (value !== undefined) {
    metadata[key] = value;
  }
}

function appendInvocationMetadata(
  metadata: MutableSkillMetadata,
  context: FrontmatterNormalizationContext,
): void {
  const { parsed, diagnostics, skillFile } = context;
  assignDefined(
    metadata,
    "whenToUse",
    normalizeStringField(
      parsed.when_to_use,
      "when_to_use",
      diagnostics,
      skillFile,
    ),
  );
  assignDefined(
    metadata,
    "arguments",
    normalizeStringArrayField(
      parsed.arguments,
      "arguments",
      diagnostics,
      skillFile,
    ),
  );
  assignDefined(
    metadata,
    "argumentHint",
    normalizeStringField(
      parsed["argument-hint"],
      "argument-hint",
      diagnostics,
      skillFile,
    ),
  );
  assignDefined(
    metadata,
    "allowedTools",
    normalizeStringArrayField(
      parsed["allowed-tools"],
      "allowed-tools",
      diagnostics,
      skillFile,
    ),
  );
}

function appendExecutionMetadata(
  metadata: MutableSkillMetadata,
  context: FrontmatterNormalizationContext,
): void {
  const { parsed, diagnostics, skillFile } = context;
  assignDefined(
    metadata,
    "model",
    normalizeStringField(parsed.model, "model", diagnostics, skillFile),
  );
  assignDefined(
    metadata,
    "effort",
    normalizeStringField(parsed.effort, "effort", diagnostics, skillFile),
  );
  assignDefined(
    metadata,
    "disableModelInvocation",
    normalizeBooleanField(
      parsed["disable-model-invocation"],
      "disable-model-invocation",
      diagnostics,
      skillFile,
    ),
  );
  assignDefined(
    metadata,
    "userInvocable",
    normalizeBooleanField(
      parsed["user-invocable"],
      "user-invocable",
      diagnostics,
      skillFile,
    ),
  );
  assignDefined(
    metadata,
    "context",
    normalizeContextField(parsed.context, diagnostics, skillFile),
  );
  assignDefined(
    metadata,
    "agent",
    normalizeStringField(parsed.agent, "agent", diagnostics, skillFile),
  );
}

function appendResourceMetadata(
  metadata: MutableSkillMetadata,
  context: FrontmatterNormalizationContext,
): void {
  const { parsed, diagnostics, skillFile } = context;
  assignDefined(
    metadata,
    "paths",
    normalizeStringArrayField(parsed.paths, "paths", diagnostics, skillFile),
  );
  assignDefined(
    metadata,
    "version",
    normalizeStringField(parsed.version, "version", diagnostics, skillFile),
  );
}

function parseSkillFrontmatter(
  frontmatterText: string,
  skillFile: string,
  source: SkillSource,
  skillRoot: string,
  directoryName: string,
): ParsedSkillEntry | null {
  const diagnostics: SkillLoadDiagnostic[] = [];
  const parsed = parseFrontmatterRecord(
    frontmatterText,
    skillFile,
    diagnostics,
  );
  if (!parsed) {
    return { diagnostics };
  }

  const context = { parsed, diagnostics, skillFile };
  appendIgnoredFieldDiagnostics(context);
  const skillMetadata = normalizeRequiredMetadata(context, directoryName);
  if (!skillMetadata) {
    return { diagnostics };
  }

  appendInvocationMetadata(skillMetadata, context);
  appendExecutionMetadata(skillMetadata, context);
  appendResourceMetadata(skillMetadata, context);

  const skill: Skill = {
    ...skillMetadata,
    source,
    skillRoot,
    skillFile,
  };

  return { skill, diagnostics };
}

export function readFrontmatterText(skillFile: string): string | null {
  const content = fs.readFileSync(skillFile, "utf8").replace(/^\uFEFF/, "");
  const match = content.match(
    /^[ \t]*---[ \t]*\r?\n(?:(?:[ \t]*(?:---|\.\.\.)[ \t]*(?:\r?\n|$))|([\s\S]*?)\r?\n[ \t]*(?:---|\.\.\.)[ \t]*(?:\r?\n|$))/,
  );

  return match ? (match[1] ?? "") : null;
}

function readSkillBody(skillFile: string): string {
  const content = fs.readFileSync(skillFile, "utf8").replace(/^\uFEFF/, "");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/);
  if (!match) {
    throw new Error(`Skill file is missing valid frontmatter: ${skillFile}`);
  }

  return content.slice(match[0].length);
}

const SOURCE_ORDER: Record<SkillSource, number> = {
  project: 0,
  user: 1,
  bundled: 2,
  plugin: 3,
  mcp: 4,
};

function compareSkillRecords(a: Skill, b: Skill): number {
  if (a.source !== b.source) {
    return SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
  }
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) {
    return byName;
  }
  return a.skillFile.localeCompare(b.skillFile);
}

function isSkillDirectoryEntry(skillRoot: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }

  try {
    return fs.statSync(path.join(skillRoot, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function collectSkillDirectories(
  skillRoot: string,
): Array<{ readonly directoryName: string; readonly directoryPath: string }> {
  if (!fs.existsSync(skillRoot)) {
    return [];
  }

  const stat = fs.statSync(skillRoot);
  if (!stat.isDirectory()) {
    return [];
  }

  const entries = fs
    .readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => !IGNORED_DIRECTORY_NAMES.has(entry.name))
    .filter((entry) => isSkillDirectoryEntry(skillRoot, entry))
    .sort((left, right) => left.name.localeCompare(right.name));

  return entries.map((entry) => ({
    directoryName: entry.name,
    directoryPath: path.join(skillRoot, entry.name),
  }));
}

function scanSkillDirectory(
  directoryPath: string,
  directoryName: string,
  source: SkillSource,
): ParsedSkillEntry | null {
  if (IGNORED_DIRECTORY_NAMES.has(directoryName)) {
    return null;
  }

  const skillFile = path.join(directoryPath, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    return {
      diagnostics: [
        createDiagnostic(
          "warning",
          "missing_skill_file",
          `Expected ${skillFile} to exist, but the skill directory does not contain SKILL.md.`,
          skillFile,
        ),
      ],
    };
  }

  const frontmatterText = readFrontmatterText(skillFile);
  if (frontmatterText === null) {
    return {
      diagnostics: [
        createDiagnostic(
          "error",
          "missing_or_malformed_frontmatter",
          `Skill file ${skillFile} must start with YAML frontmatter.`,
          skillFile,
        ),
      ],
    };
  }

  return parseSkillFrontmatter(
    frontmatterText,
    skillFile,
    source,
    directoryPath,
    directoryName,
  );
}

function scanSkillRoot(
  root: {
    readonly source: SkillSource;
    readonly skillRoot: string;
  },
  diagnostics: SkillLoadDiagnostic[],
  skills: Skill[],
): void {
  const directories = collectSkillDirectories(root.skillRoot);
  for (const entry of directories) {
    const parsed = scanSkillDirectory(
      entry.directoryPath,
      entry.directoryName,
      root.source,
    );
    if (!parsed) {
      continue;
    }

    diagnostics.push(...parsed.diagnostics);
    if (parsed.skill) {
      skills.push(parsed.skill);
    }
  }
}

function appendDuplicateSkillDiagnostics(
  skills: Skill[],
  diagnostics: SkillLoadDiagnostic[],
): void {
  const skillBuckets = new Map<string, Skill[]>();
  for (const skill of skills) {
    const bucket = skillBuckets.get(skill.name);
    if (bucket) {
      bucket.push(skill);
    } else {
      skillBuckets.set(skill.name, [skill]);
    }
  }

  const duplicates = Array.from(skillBuckets.values()).filter(
    (bucket) => bucket.length > 1,
  );
  if (duplicates.length === 0) {
    return;
  }

  for (const bucket of duplicates) {
    const paths = bucket.map((skill) => `- ${skill.skillFile}`).join("\n");
    diagnostics.push(
      createDiagnostic(
        "error",
        "duplicate_skill_name",
        `Skill name "${bucket[0].name}" is defined multiple times:\n${paths}`,
        bucket[0].skillFile,
        bucket[0].name,
      ),
    );
  }
}

function scanLocalSkills(context: SkillContext): LocalSkillScanResult {
  const diagnostics: SkillLoadDiagnostic[] = [];
  const skills: Skill[] = [];

  const roots: Array<{
    readonly source: SkillSource;
    readonly skillRoot: string;
  }> = [
    {
      source: "project",
      skillRoot: path.join(
        normalizeAbsolutePath(context.cwd),
        ".propio",
        "skills",
      ),
    },
    {
      source: "user",
      skillRoot: path.join(
        normalizeAbsolutePath(context.homeDir),
        ".propio",
        "skills",
      ),
    },
  ];

  for (const root of roots) {
    scanSkillRoot(root, diagnostics, skills);
  }

  appendDuplicateSkillDiagnostics(skills, diagnostics);
  skills.sort(compareSkillRecords);
  return { skills, diagnostics };
}

export function loadLocalSkills(
  options: Partial<SkillContext> = {},
): LoadLocalSkillsResult {
  const context: SkillContext = {
    cwd: normalizeAbsolutePath(options.cwd ?? process.cwd()),
    homeDir: normalizeAbsolutePath(options.homeDir ?? os.homedir()),
  };

  const result = scanLocalSkills(context);
  const registry = SkillRegistry.create(
    context,
    result.skills,
    result.diagnostics,
    scanLocalSkills,
    readSkillBody,
  );
  return {
    registry,
    diagnostics: result.diagnostics,
  };
}
