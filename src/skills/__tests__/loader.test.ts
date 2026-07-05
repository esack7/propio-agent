import * as path from "path";
import * as os from "os";
import { createRequire } from "module";
import { loadLocalSkills } from "../index.js";
import { readFrontmatterText } from "../loader.js";

const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");

describe("skills loader", () => {
  const tempRoot = path.join(os.tmpdir(), "propio-skills-loader-tests");
  const projectRoot = path.join(tempRoot, "project");
  const homeRoot = path.join(tempRoot, "home");
  const directorySymlinkType =
    process.platform === "win32" ? "junction" : "dir";

  function supportsFileSymlinks(): boolean {
    const probeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "propio-file-symlink-probe-"),
    );
    const target = path.join(probeRoot, "target");
    const link = path.join(probeRoot, "link");
    fs.writeFileSync(target, "probe");

    try {
      fs.symlinkSync(target, link, "file");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return false;
      }
      throw error;
    } finally {
      fs.rmSync(probeRoot, { recursive: true, force: true });
    }
  }

  const itWithFileSymlinks = supportsFileSymlinks() ? it : it.skip;

  beforeAll(() => {
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(homeRoot, { recursive: true });
  });

  beforeEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(homeRoot, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeSkill(
    root: string,
    directoryName: string,
    fileContent: string,
  ): string {
    const skillDir = path.join(root, ".propio", "skills", directoryName);
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillFile, fileContent);
    return skillFile;
  }

  it("discovers project and user skills with normalized frontmatter", () => {
    writeSkill(
      projectRoot,
      "ProjectSkill",
      `---
description: Project skill description
when_to_use: |
  Use this when you need a project skill.
arguments:
  - first
  - second
argument-hint: provide the task
allowed-tools:
  - read
  - bash
model: claude
effort: medium
disable-model-invocation: true
user-invocable: false
context: inline
agent: helper
paths:
  - src/**
version: 1.0.0
ignored-field: should be ignored
---
Project body
`,
    );

    writeSkill(
      homeRoot,
      "user-skill",
      `---
description: User skill description
---
User body
`,
    );

    const { registry, diagnostics } = loadLocalSkills({
      cwd: projectRoot,
      homeDir: homeRoot,
    });

    expect(
      diagnostics.some((item) => item.code === "ignored_frontmatter_field"),
    ).toBe(true);

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      name: "projectskill",
      description: "Project skill description",
      whenToUse: "Use this when you need a project skill.",
      arguments: ["first", "second"],
      argumentHint: "provide the task",
      allowedTools: ["read", "bash"],
      model: "claude",
      effort: "medium",
      disableModelInvocation: true,
      userInvocable: false,
      context: "inline",
      agent: "helper",
      paths: ["src/**"],
      version: "1.0.0",
      source: "project",
      skillRoot: path.join(projectRoot, ".propio", "skills", "ProjectSkill"),
    });
    expect(list[1]).toMatchObject({
      name: "user-skill",
      description: "User skill description",
      source: "user",
      skillRoot: path.join(homeRoot, ".propio", "skills", "user-skill"),
    });

    const materialized = registry.materialize("projectskill");
    expect(materialized).toContain(
      `Base directory for this skill: ${path.join(
        projectRoot,
        ".propio",
        "skills",
        "ProjectSkill",
      )}`,
    );
    expect(materialized).toContain("Project body");
  });

  it("returns an empty registry when skills directories are missing", () => {
    const { registry, diagnostics } = loadLocalSkills({
      cwd: projectRoot,
      homeDir: homeRoot,
    });

    expect(registry.list()).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it("discovers a project skill through a directory symlink", () => {
    const targetRoot = path.join(tempRoot, "shared-skills");
    const targetDirectory = path.join(targetRoot, "target-directory");
    const linkedDirectory = path.join(
      projectRoot,
      ".propio",
      "skills",
      "linked-skill",
    );
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(targetDirectory, "SKILL.md"),
      `---
description: Linked project skill
---
Linked skill body
`,
    );
    fs.mkdirSync(path.dirname(linkedDirectory), { recursive: true });
    fs.symlinkSync(targetDirectory, linkedDirectory, directorySymlinkType);

    const { registry, diagnostics } = loadLocalSkills({
      cwd: projectRoot,
      homeDir: homeRoot,
    });

    expect(diagnostics).toHaveLength(0);
    expect(registry.list()).toEqual([
      expect.objectContaining({
        name: "linked-skill",
        source: "project",
        skillRoot: linkedDirectory,
        skillFile: path.join(linkedDirectory, "SKILL.md"),
      }),
    ]);
    expect(registry.materialize("linked-skill")).toContain("Linked skill body");
  });

  it("ignores broken skill symlinks without diagnostics", () => {
    const skillRoot = path.join(projectRoot, ".propio", "skills");
    const missingTarget = path.join(tempRoot, "missing-skill-target");
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.mkdirSync(missingTarget, { recursive: true });
    fs.symlinkSync(
      missingTarget,
      path.join(skillRoot, "broken-skill"),
      directorySymlinkType,
    );
    fs.rmSync(missingTarget, { recursive: true, force: true });

    const { registry, diagnostics } = loadLocalSkills({
      cwd: projectRoot,
      homeDir: homeRoot,
    });

    expect(registry.list()).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  itWithFileSymlinks(
    "ignores skill symlinks to non-directory targets without diagnostics",
    () => {
      const skillRoot = path.join(projectRoot, ".propio", "skills");
      const fileTarget = path.join(tempRoot, "not-a-skill-directory");
      fs.mkdirSync(skillRoot, { recursive: true });
      fs.writeFileSync(fileTarget, "SKILL.md-like content");
      fs.symlinkSync(fileTarget, path.join(skillRoot, "file-skill"), "file");

      const { registry, diagnostics } = loadLocalSkills({
        cwd: projectRoot,
        homeDir: homeRoot,
      });

      expect(registry.list()).toHaveLength(0);
      expect(diagnostics).toHaveLength(0);
    },
  );

  it("reports invalid names and malformed frontmatter", () => {
    writeSkill(
      projectRoot,
      "invalid name",
      `---
description: Invalid skill
---
Body
`,
    );

    writeSkill(
      homeRoot,
      "malformed",
      `---
description: Missing closing fence
Body
`,
    );

    const { registry, diagnostics } = loadLocalSkills({
      cwd: projectRoot,
      homeDir: homeRoot,
    });

    expect(registry.list()).toHaveLength(0);
    expect(diagnostics.some((item) => item.code === "invalid_skill_name")).toBe(
      true,
    );
    expect(
      diagnostics.some(
        (item) => item.code === "missing_or_malformed_frontmatter",
      ),
    ).toBe(true);
  });

  it("skips missing SKILL.md files and ignored dependency directories", () => {
    const skillRoot = path.join(projectRoot, ".propio", "skills");
    fs.mkdirSync(path.join(skillRoot, "missing-file"), { recursive: true });
    fs.mkdirSync(path.join(skillRoot, "dist"), { recursive: true });
    fs.mkdirSync(path.join(skillRoot, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(skillRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(skillRoot, "coverage"), { recursive: true });

    const { registry, diagnostics } = loadLocalSkills({
      cwd: projectRoot,
      homeDir: homeRoot,
    });

    expect(registry.list()).toHaveLength(0);
    expect(diagnostics.some((item) => item.code === "missing_skill_file")).toBe(
      true,
    );
    expect(
      diagnostics.filter((item) => item.code === "ignored_directory").length,
    ).toBe(0);
  });

  it("reports duplicate normalized names without aborting discovery", () => {
    writeSkill(
      projectRoot,
      "alpha",
      `---
description: First duplicate
---
Alpha body
`,
    );

    writeSkill(
      homeRoot,
      "ALPHA",
      `---
description: Second duplicate
---
Beta body
`,
    );

    const { registry, diagnostics } = loadLocalSkills({
      cwd: projectRoot,
      homeDir: homeRoot,
    });

    expect(registry.list()).toHaveLength(2);
    expect(
      diagnostics.some((item) => item.code === "duplicate_skill_name"),
    ).toBe(true);
  });

  it("does not read the body during discovery but does during materialization", () => {
    writeSkill(
      projectRoot,
      "lazy",
      `---
description: Lazy skill
---
${"Body line\n".repeat(1000)}
`,
    );

    const { registry } = loadLocalSkills({
      cwd: projectRoot,
      homeDir: homeRoot,
    });

    expect(registry.get("lazy")).toBeDefined();

    const materialized = registry.materialize("lazy");
    expect(materialized).toContain("Base directory for this skill:");
    expect(materialized).toContain("Body line");
  });

  it("records unknown placeholder warnings in diagnostics during materialization", () => {
    writeSkill(
      projectRoot,
      "placeholder",
      `---
description: Placeholder skill
---
Use $MISSING with $ARGUMENTS.
`,
    );

    const { registry, diagnostics } = loadLocalSkills({
      cwd: projectRoot,
      homeDir: homeRoot,
    });

    expect(
      diagnostics.some((item) => item.code === "unknown_placeholder"),
    ).toBe(false);

    const materialized = registry.materialize("placeholder", {
      arguments: "alpha",
    });

    expect(materialized).toContain("Use $MISSING with alpha.");
    expect(
      diagnostics.some((item) => item.code === "unknown_placeholder"),
    ).toBe(true);
  });

  it("reads frontmatter with BOMs, standard fences, and ellipsis terminators", () => {
    const standardFile = path.join(tempRoot, "standard-frontmatter.md");
    const bomFile = path.join(tempRoot, "bom-frontmatter.md");
    const ellipsisFile = path.join(tempRoot, "ellipsis-frontmatter.md");

    fs.writeFileSync(
      standardFile,
      `---
description: Standard skill
---
Body
`,
    );
    fs.writeFileSync(
      bomFile,
      `\uFEFF---
description: BOM skill
---
Body
`,
    );
    fs.writeFileSync(
      ellipsisFile,
      `---
description: Ellipsis skill
...
Body
`,
    );

    expect(readFrontmatterText(standardFile)).toBe(
      "description: Standard skill",
    );
    expect(readFrontmatterText(bomFile)).toBe("description: BOM skill");
    expect(readFrontmatterText(ellipsisFile)).toBe(
      "description: Ellipsis skill",
    );
  });

  it("returns null for missing and malformed frontmatter", () => {
    const missingFile = path.join(tempRoot, "missing-frontmatter.md");
    const malformedFile = path.join(tempRoot, "malformed-frontmatter.md");
    const laterBlockFile = path.join(tempRoot, "later-frontmatter-block.md");

    fs.writeFileSync(missingFile, "description: Missing fence\n");
    fs.writeFileSync(
      malformedFile,
      `---
description: Missing closing fence
Body
`,
    );
    fs.writeFileSync(
      laterBlockFile,
      `Intro prose before the skill metadata.

---
description: Later block should not count
---
Body
`,
    );

    expect(readFrontmatterText(missingFile)).toBeNull();
    expect(readFrontmatterText(malformedFile)).toBeNull();
    expect(readFrontmatterText(laterBlockFile)).toBeNull();
  });
});
