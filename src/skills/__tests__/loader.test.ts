import * as path from "path";
import { createRequire } from "module";
import { loadLocalSkills } from "../index.js";

const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");

describe("skills loader", () => {
  const tempRoot = path.join("/tmp", "propio-skills-loader-tests");
  const projectRoot = path.join(tempRoot, "project");
  const homeRoot = path.join(tempRoot, "home");

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

  it("throws on duplicate normalized names and lists every conflicting file", () => {
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

    expect(() =>
      loadLocalSkills({
        cwd: projectRoot,
        homeDir: homeRoot,
      }),
    ).toThrow(/skill name "alpha"[\s\S]*SKILL\.md/i);
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
});
