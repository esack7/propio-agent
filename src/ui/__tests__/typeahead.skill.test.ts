import {
  createSkillCommandTypeaheadProvider,
  createTypeaheadState,
} from "../typeahead.js";
import type { Skill } from "../../skills/types.js";

describe("skill command typeahead", () => {
  const skills: Skill[] = [
    {
      name: "alpha",
      source: "project",
      skillRoot: "/repo/.propio/skills/alpha",
      skillFile: "/repo/.propio/skills/alpha/SKILL.md",
      description: "Alpha",
    },
    {
      name: "beta",
      source: "user",
      skillRoot: "/home/test/.propio/skills/beta",
      skillFile: "/home/test/.propio/skills/beta/SKILL.md",
      description: "Beta",
      userInvocable: false,
    },
  ];

  it("suggests only user-invocable skills for /skill", () => {
    const state = createTypeaheadState({
      buffer: "/skill ",
      cursor: 7,
      workspaceRoot: "/repo",
      typeaheadProviders: [createSkillCommandTypeaheadProvider(() => skills)],
    });

    expect(state?.suggestions.map((suggestion) => suggestion.value)).toEqual([
      "/skill alpha",
    ]);
  });

  it("does not compete with the /skills command", () => {
    const state = createTypeaheadState({
      buffer: "/skills",
      cursor: 7,
      workspaceRoot: "/repo",
      typeaheadProviders: [createSkillCommandTypeaheadProvider(() => skills)],
    });

    expect(state?.suggestions).toEqual([]);
  });
});
