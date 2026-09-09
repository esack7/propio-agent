import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadSkills,
  parseSkillDocument,
  type SkillDiscoveryRoot,
} from "../index.js";
import { loadLocalSkills } from "../loader.js";

describe("public skills boundary", () => {
  let workspace: string;
  let roots: SkillDiscoveryRoot[];

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skills-boundary-"));
    roots = [
      { source: "project", skillRoot: path.join(workspace, ".propio/skills") },
      {
        source: "user",
        skillRoot: path.join(workspace, "home/.propio/skills"),
      },
    ];
  });

  afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

  function writeSkill(root: SkillDiscoveryRoot, fields = "", body = "Body") {
    const directory = path.join(root.skillRoot, "example");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "SKILL.md");
    fs.writeFileSync(
      file,
      `---\ndescription: ${root.source}\n${fields}---\n${body}\n`,
    );
    return file;
  }

  it("matches the CLI adapter for identical supplied roots and diagnostics", () => {
    roots.forEach((root) => writeSkill(root));
    const cli = loadLocalSkills({
      cwd: workspace,
      homeDir: path.join(workspace, "home"),
    });
    const catalog = loadSkills({ workspaceRoot: workspace, roots });
    expect(catalog.registry.list()).toEqual(cli.registry.list());
    expect(catalog.diagnostics).toEqual(cli.diagnostics);
    expect(catalog.registry.get("example")?.source).toBe("user");
    expect(catalog.registry.materialize("example")).toEqual(
      cli.registry.materialize("example"),
    );
  });

  it("uses supplied root order rather than source labels, including after activation and refresh", () => {
    roots.forEach((root) => writeSkill(root));
    const { registry } = loadSkills({
      workspaceRoot: workspace,
      roots: [...roots].reverse(),
    });
    expect(registry.get("example")?.source).toBe("project");
    registry.recordFileTouch(["src/app.ts"]);
    expect(registry.get("example")?.source).toBe("project");
    registry.refresh();
    expect(registry.get("example")?.source).toBe("project");
    expect(registry.list().map((skill) => skill.source)).toEqual([
      "user",
      "project",
    ]);
  });

  it("sorts normalized metadata names within each root, preserving CLI listing order", () => {
    const first = writeSkill(roots[0], "name: zulu\n");
    const second = path.join(roots[0].skillRoot, "z-directory/SKILL.md");
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.writeFileSync(
      second,
      "---\nname: alpha\ndescription: First by name\n---\nBody\n",
    );
    const { registry } = loadSkills({ workspaceRoot: workspace, roots });
    expect(registry.list().map((skill) => skill.skillFile)).toEqual([
      second,
      first,
    ]);
  });

  it("snapshots the roots while re-reading skill contents on refresh", () => {
    const file = writeSkill(roots[0]);
    const { registry } = loadSkills({ workspaceRoot: workspace, roots });
    roots[0] = {
      source: "plugin",
      skillRoot: path.join(workspace, "elsewhere"),
    };
    roots.pop();
    fs.writeFileSync(file, "---\ndescription: Updated\n---\nUpdated body\n");
    registry.refresh();
    expect(registry.get("example")?.description).toBe("Updated");
    expect(registry.materialize("example")).toContain("Updated body");
  });

  it("matches relative paths against the supplied workspace and retains deepest-match precedence", () => {
    const deep = {
      source: "plugin" as const,
      skillRoot: path.join(workspace, "packages/app/skills"),
    };
    [deep, roots[0]].forEach((root) => writeSkill(root, 'paths: ["src/**"]\n'));
    const { registry } = loadSkills({
      workspaceRoot: workspace,
      roots: [deep, roots[0]],
    });
    expect(registry.listModelInvocable()).toEqual([]);
    registry.recordFileTouch(["node_modules/src/app.ts", "../src/app.ts"]);
    expect(registry.listModelInvocable()).toEqual([]);
    registry.recordFileTouch(["src/app.ts"]);
    expect(registry.get("example")?.source).toBe("plugin");
    registry.refresh();
    expect(registry.get("example")?.source).toBe("plugin");
  });

  it("keeps execution requests as metadata and materializes instructions without running them", () => {
    const fields =
      "context: fork\nagent: reviewer\nmodel: requested-model\neffort: high\nallowed-tools: [bash]\nunsupported-execution: true\n";
    const file = writeSkill(
      roots[0],
      fields,
      "Run !`echo should-not-run` with $ARGUMENTS.",
    );
    const parsed = parseSkillDocument(fs.readFileSync(file, "utf8"), {
      skillFile: file,
      source: "project",
    });
    expect(parsed.skill).toMatchObject({
      context: "fork",
      agent: "reviewer",
      model: "requested-model",
      effort: "high",
      allowedTools: ["bash"],
    });
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({ code: "ignored_frontmatter_field" }),
    ]);
    const { registry } = loadSkills({ workspaceRoot: workspace, roots });
    expect(registry.materialize("example", { arguments: "hello" })).toContain(
      "Run !`echo should-not-run` with hello.",
    );
  });

  it("does not discover convention-based skills when no roots were supplied", () => {
    writeSkill(roots[0]);
    expect(
      loadSkills({ workspaceRoot: workspace, roots: [] }).registry.list(),
    ).toEqual([]);
  });

  it("rejects implicit working-directory inputs before discovery", () => {
    expect(() => loadSkills({ workspaceRoot: ".", roots })).toThrow(
      "workspaceRoot must be an absolute path",
    );
    expect(() =>
      loadSkills({
        workspaceRoot: workspace,
        roots: [{ source: "project", skillRoot: "relative" }],
      }),
    ).toThrow("skillRoot must be an absolute path");
    expect(() =>
      parseSkillDocument("---\ndescription: Test\n---\n", {
        skillFile: "SKILL.md",
        source: "project",
      }),
    ).toThrow("skillFile must be an absolute path");
  });
});
