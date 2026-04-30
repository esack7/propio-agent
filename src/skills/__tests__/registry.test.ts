import { SkillRegistry } from "../registry.js";
import type { Skill } from "../types.js";

describe("skill registry", () => {
  function createRegistry(skills: Skill[]): SkillRegistry {
    return SkillRegistry.create(
      {
        cwd: "/repo",
        homeDir: "/home/test",
      },
      skills,
      [],
      () => ({ skills, diagnostics: [] }),
      (skillFile) =>
        `Body for ${skillFile}\nUse $0 and $second with $ARGUMENTS.`,
    );
  }

  it("materializes arguments with positional and named placeholders", () => {
    const registry = createRegistry([
      {
        name: "example",
        source: "project",
        skillRoot: "/repo/.propio/skills/example",
        skillFile: "/repo/.propio/skills/example/SKILL.md",
        description: "Example skill",
        arguments: ["first", "second"],
      },
    ]);

    const materialized = registry.materialize("example", {
      arguments: "alpha beta",
    });

    expect(materialized).toContain("Base directory for this skill:");
    expect(materialized).toContain(
      "Body for /repo/.propio/skills/example/SKILL.md",
    );
    expect(materialized).toContain("Use alpha and beta with alpha beta.");
    expect(materialized).not.toContain("ARGUMENTS: alpha beta");
  });

  it("keeps path-scoped skills dormant until a matching file is touched", () => {
    const registry = createRegistry([
      {
        name: "path-skill",
        source: "project",
        skillRoot: "/repo/.propio/skills/path-skill",
        skillFile: "/repo/.propio/skills/path-skill/SKILL.md",
        description: "Path scoped skill",
        paths: ["src/**"],
      },
    ]);

    expect(registry.listUserInvocable()).toHaveLength(0);

    registry.recordFileTouch(["/repo/src/app.ts"]);

    expect(registry.listUserInvocable()).toHaveLength(1);
    expect(registry.listUserInvocable()[0].name).toBe("path-skill");
  });

  it("activates unrelated matching path skills independently", () => {
    const registry = createRegistry([
      {
        name: "alpha",
        source: "project",
        skillRoot: "/repo/.propio/skills/alpha",
        skillFile: "/repo/.propio/skills/alpha/SKILL.md",
        description: "Alpha skill",
        paths: ["src/**"],
      },
      {
        name: "beta",
        source: "project",
        skillRoot: "/repo/packages/app/.propio/skills/beta",
        skillFile: "/repo/packages/app/.propio/skills/beta/SKILL.md",
        description: "Beta skill",
        paths: ["src/**"],
      },
    ]);

    const activated = registry.recordFileTouch(["/repo/src/app.ts"]);
    expect(activated.map((skill) => skill.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expect(
      registry
        .listUserInvocable()
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
  });

  it("prefers the deepest matching skill when names collide", () => {
    const registry = createRegistry([
      {
        name: "collide",
        source: "project",
        skillRoot: "/repo/.propio/skills/collide",
        skillFile: "/repo/.propio/skills/collide/SKILL.md",
        description: "Shallow collide skill",
        paths: ["src/**"],
      },
      {
        name: "collide",
        source: "project",
        skillRoot: "/repo/packages/app/.propio/skills/collide",
        skillFile: "/repo/packages/app/.propio/skills/collide/SKILL.md",
        description: "Deep collide skill",
        paths: ["src/**"],
      },
    ]);

    const activated = registry.recordFileTouch(["/repo/src/app.ts"]);
    expect(activated).toHaveLength(1);
    expect(activated[0].skillRoot).toBe(
      "/repo/packages/app/.propio/skills/collide",
    );
    expect(registry.listUserInvocable()).toHaveLength(1);
    expect(registry.listUserInvocable()[0].skillRoot).toBe(
      "/repo/packages/app/.propio/skills/collide",
    );
  });
});
