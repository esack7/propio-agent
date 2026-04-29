import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StringDecoder } from "string_decoder";
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

function createDiagnostic(
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
        "warning",
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
        "warning",
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
        "warning",
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
          "warning",
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

function parseSkillFrontmatter(
  frontmatterText: string,
  skillFile: string,
  source: SkillSource,
  skillRoot: string,
  directoryName: string,
): ParsedSkillEntry | null {
  const diagnostics: SkillLoadDiagnostic[] = [];
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
    return { diagnostics };
  }

  const parsed = document.toJS();
  if (!isPlainObject(parsed)) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "invalid_frontmatter_shape",
        `Frontmatter in ${skillFile} must be a YAML mapping/object.`,
        skillFile,
      ),
    );
    return { diagnostics };
  }

  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_FIELD_NAMES.has(key)) {
      diagnostics.push(
        createDiagnostic(
          "info",
          "ignored_frontmatter_field",
          `Ignoring unsupported frontmatter field "${key}" in ${skillFile}.`,
          skillFile,
        ),
      );
    }
  }

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
  const normalizedName = normalizeSkillName(frontmatterName ?? directoryName);
  if (!normalizedName) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "invalid_skill_name",
        `Invalid skill name in ${skillFile}. Skill names must use letters, numbers, "_", "-", and ":".`,
        skillFile,
        frontmatterName ?? directoryName,
      ),
    );
    return { diagnostics };
  }

  if (!description) {
    return { diagnostics };
  }

  const whenToUse = normalizeStringField(
    parsed.when_to_use,
    "when_to_use",
    diagnostics,
    skillFile,
  );
  const argumentsList = normalizeStringArrayField(
    parsed.arguments,
    "arguments",
    diagnostics,
    skillFile,
  );
  const argumentHint = normalizeStringField(
    parsed["argument-hint"],
    "argument-hint",
    diagnostics,
    skillFile,
  );
  const allowedTools = normalizeStringArrayField(
    parsed["allowed-tools"],
    "allowed-tools",
    diagnostics,
    skillFile,
  );
  const model = normalizeStringField(
    parsed.model,
    "model",
    diagnostics,
    skillFile,
  );
  const effort = normalizeStringField(
    parsed.effort,
    "effort",
    diagnostics,
    skillFile,
  );
  const disableModelInvocation = normalizeBooleanField(
    parsed["disable-model-invocation"],
    "disable-model-invocation",
    diagnostics,
    skillFile,
  );
  const userInvocable = normalizeBooleanField(
    parsed["user-invocable"],
    "user-invocable",
    diagnostics,
    skillFile,
  );
  const context = normalizeContextField(parsed.context, diagnostics, skillFile);
  const agent = normalizeStringField(
    parsed.agent,
    "agent",
    diagnostics,
    skillFile,
  );
  const paths = normalizeStringArrayField(
    parsed.paths,
    "paths",
    diagnostics,
    skillFile,
  );
  const version = normalizeStringField(
    parsed.version,
    "version",
    diagnostics,
    skillFile,
  );

  const skillMetadata: SkillMetadata = {
    name: normalizedName,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    ...(argumentsList ? { arguments: argumentsList } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(userInvocable !== undefined ? { userInvocable } : {}),
    ...(context ? { context } : {}),
    ...(agent ? { agent } : {}),
    ...(paths ? { paths } : {}),
    ...(version ? { version } : {}),
  };

  const skill: Skill = {
    ...skillMetadata,
    source,
    skillRoot,
    skillFile,
  };

  return { skill, diagnostics };
}

function readFrontmatterText(skillFile: string): string | null {
  const fd = fs.openSync(skillFile, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.alloc(4096);
  let pending = "";
  let isFirstLine = true;
  let insideFrontmatter = false;
  const frontmatterLines: string[] = [];

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        pending += decoder.end();
      } else {
        pending += decoder.write(buffer.subarray(0, bytesRead));
      }

      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        let line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        line = line.replace(/\r$/, "");
        if (isFirstLine) {
          isFirstLine = false;
          line = line.replace(/^\uFEFF/, "");
          if (line.trim() !== "---") {
            return null;
          }
          insideFrontmatter = true;
        } else if (insideFrontmatter) {
          if (line.trim() === "---" || line.trim() === "...") {
            return frontmatterLines.join("\n");
          }
          frontmatterLines.push(line);
        }
        newlineIndex = pending.indexOf("\n");
      }

      if (bytesRead === 0) {
        break;
      }
    }

    if (pending.length > 0) {
      let line = pending.replace(/\r$/, "").replace(/^\uFEFF/, "");
      if (isFirstLine) {
        if (line.trim() !== "---") {
          return null;
        }
        return null;
      }

      if (insideFrontmatter) {
        if (line.trim() === "---" || line.trim() === "...") {
          return frontmatterLines.join("\n");
        }
        frontmatterLines.push(line);
      }
    }

    return insideFrontmatter ? null : null;
  } finally {
    fs.closeSync(fd);
  }
}

function readSkillBody(skillFile: string): string {
  const content = fs.readFileSync(skillFile, "utf8").replace(/^\uFEFF/, "");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/);
  if (!match) {
    throw new Error(`Skill file is missing valid frontmatter: ${skillFile}`);
  }

  return content.slice(match[0].length);
}

function cloneSkill(skill: Skill): Skill {
  return {
    ...skill,
    ...(skill.arguments ? { arguments: [...skill.arguments] } : {}),
    ...(skill.allowedTools ? { allowedTools: [...skill.allowedTools] } : {}),
    ...(skill.paths ? { paths: [...skill.paths] } : {}),
  };
}

function compareSkillRecords(a: Skill, b: Skill): number {
  if (a.source !== b.source) {
    return a.source === "project" ? -1 : 1;
  }
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) {
    return byName;
  }
  return a.skillFile.localeCompare(b.skillFile);
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
    .filter((entry) => entry.isDirectory())
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
  if (duplicates.length > 0) {
    const duplicateMessages = duplicates.map((bucket) => {
      const paths = bucket.map((skill) => `- ${skill.skillFile}`).join("\n");
      return `Skill name "${bucket[0].name}" is defined multiple times:\n${paths}`;
    });
    throw new Error(duplicateMessages.join("\n\n"));
  }

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

export {
  cloneSkill,
  collectSkillDirectories,
  normalizeSkillName,
  readFrontmatterText,
  readSkillBody,
  scanLocalSkills,
};
