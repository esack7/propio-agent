import * as path from "path";
import { parseDocument } from "yaml";
import type {
  ParsedSkillEntry,
  Skill,
  SkillContextMode,
  SkillLoadDiagnostic,
  SkillMetadata,
  SkillSource,
} from "./types.js";
import { createSkillDiagnostic as createDiagnostic } from "./shared.js";

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
): ParsedSkillEntry {
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

function splitSkillDocument(
  text: string,
): { frontmatter: string; body: string } | null {
  const content = text.replace(/^\uFEFF/, "");
  const match = content.match(
    /^[ \t]*---[ \t]*\r?\n(?:(?:[ \t]*(?:---|\.\.\.)[ \t]*(?:\r?\n|$))|([\s\S]*?)\r?\n[ \t]*(?:---|\.\.\.)[ \t]*(?:\r?\n|$))/,
  );
  return match
    ? { frontmatter: match[1] ?? "", body: content.slice(match[0].length) }
    : null;
}

export function extractFrontmatterText(text: string): string | null {
  return splitSkillDocument(text)?.frontmatter ?? null;
}

export function extractSkillBody(text: string, skillFile: string): string {
  const document = splitSkillDocument(text);
  if (!document) {
    throw new Error(`Skill file is missing valid frontmatter: ${skillFile}`);
  }
  return document.body;
}

/** Parse metadata without reading files or executing skill instructions. */
export function parseSkillDocument(
  content: string,
  options: { readonly skillFile: string; readonly source: SkillSource },
): ParsedSkillEntry {
  const { skillFile, source } = options;
  if (!path.isAbsolute(skillFile)) {
    throw new Error("skillFile must be an absolute path.");
  }
  const frontmatter = extractFrontmatterText(content);
  if (frontmatter === null) {
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
  const skillRoot = path.dirname(skillFile);
  return parseSkillFrontmatter(
    frontmatter,
    skillFile,
    source,
    skillRoot,
    path.basename(skillRoot),
  );
}
