import { renderSkillDiscoveryBlock } from "../discovery.js";
import type { Skill } from "../types.js";

describe("skill discovery", () => {
  it("renders metadata only and keeps full bodies out of the prompt block", () => {
    const skills: Skill[] = [
      {
        name: "alpha",
        source: "project",
        skillRoot: "/tmp/project/.propio/skills/alpha",
        skillFile: "/tmp/project/.propio/skills/alpha/SKILL.md",
        description: "Alpha description",
        whenToUse: "Use alpha when you need it.",
      },
      {
        name: "beta",
        source: "user",
        skillRoot: "/tmp/home/.propio/skills/beta",
        skillFile: "/tmp/home/.propio/skills/beta/SKILL.md",
        description: "Beta description",
      },
    ];

    const block = renderSkillDiscoveryBlock(skills);

    expect(block).toContain("<skills>");
    expect(block).toContain("name: alpha");
    expect(block).toContain("source: project");
    expect(block).toContain("whenToUse: Use alpha when you need it.");
    expect(block).toContain("name: beta");
    expect(block).not.toContain("SKILL.md");
  });

  it("truncates the block by whole skill entries", () => {
    const skills: Skill[] = Array.from({ length: 80 }, (_, index) => ({
      name: `skill-${index}`,
      source: "project",
      skillRoot: `/tmp/project/.propio/skills/skill-${index}`,
      skillFile: `/tmp/project/.propio/skills/skill-${index}/SKILL.md`,
      description:
        "A very long description that keeps the block growing until the cap is reached.",
      whenToUse: "Use this skill for testing truncation behavior.",
    }));

    const block = renderSkillDiscoveryBlock(skills);

    expect(block.length).toBeLessThanOrEqual(3000);
    expect(block).toContain("skill-0");
    expect(block).not.toContain("skill-79");
  });
});
