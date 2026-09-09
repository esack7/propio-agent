import * as fs from "fs";
import * as path from "path";
import { SkillRegistry } from "./registry.js";
import { parseSkillDocument, extractSkillBody } from "./parser.js";
import { createSkillDiagnostic as createDiagnostic } from "./shared.js";
import type {
  Skill,
  SkillSource,
  SkillLoadDiagnostic,
  ParsedSkillEntry,
  LoadSkillsOptions,
  LoadSkillsResult,
  SkillDiscoveryRoot,
} from "./types.js";

const IGNORED_DIRECTORY_NAMES = new Set([
  "dist",
  "node_modules",
  ".git",
  "coverage",
]);

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
): ParsedSkillEntry {
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

  return parseSkillDocument(fs.readFileSync(skillFile, "utf8"), {
    skillFile,
    source,
  });
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
  const rootSkills: Skill[] = [];
  for (const entry of directories) {
    const parsed = scanSkillDirectory(
      entry.directoryPath,
      entry.directoryName,
      root.source,
    );
    diagnostics.push(...parsed.diagnostics);
    if (parsed.skill) {
      rootSkills.push(parsed.skill);
    }
  }
  rootSkills.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.skillFile.localeCompare(right.skillFile),
  );
  skills.push(...rootSkills);
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

function scanSkills(roots: readonly SkillDiscoveryRoot[]) {
  const diagnostics: SkillLoadDiagnostic[] = [];
  const skills: Skill[] = [];
  for (const root of roots) {
    scanSkillRoot(root, diagnostics, skills);
  }
  appendDuplicateSkillDiagnostics(skills, diagnostics);
  return { skills, diagnostics };
}

/** Explicit Node filesystem discovery; later roots override earlier unscoped entries. */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
  if (!path.isAbsolute(options.workspaceRoot)) {
    throw new Error("workspaceRoot must be an absolute path.");
  }
  const roots = options.roots.map((root) => {
    if (!path.isAbsolute(root.skillRoot)) {
      throw new Error("Every skillRoot must be an absolute path.");
    }
    return { ...root };
  });
  const reload = () => scanSkills(roots);
  const result = reload();
  const registry = SkillRegistry.create(
    { cwd: options.workspaceRoot },
    result.skills,
    result.diagnostics,
    reload,
    (skillFile) =>
      extractSkillBody(fs.readFileSync(skillFile, "utf8"), skillFile),
  );
  return { registry, diagnostics: result.diagnostics };
}
