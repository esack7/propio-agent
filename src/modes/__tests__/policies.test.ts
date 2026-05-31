import { describe, expect, it } from "@jest/globals";
import {
  DISCOVER_MODE_TOOLS,
  PLAN_MODE_TOOLS,
  resolveEffectiveToolAllowlist,
} from "../policies.js";

describe("resolveEffectiveToolAllowlist", () => {
  const enabledBuiltinNames = [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "find",
    "ls",
    "skill",
  ];
  const connectedMcpToolNames = ["mcp_search", "mcp_write"];

  function expectReadOnlyModeBaseline(options: {
    mode: "discover" | "plan";
    allowedTools: string[];
    deniedTool: string;
  }): void {
    const allowed = resolveEffectiveToolAllowlist({
      mode: options.mode,
      skillScopes: [
        {
          invocationSource: "user",
          skillName: "scope-lock",
          skillRoot: "/tmp",
          skillFile: "/tmp/SKILL.md",
          allowedTools: options.allowedTools,
        },
      ],
      enabledBuiltinNames,
      connectedMcpToolNames,
    });

    expect(allowed).toEqual(
      new Set(
        DISCOVER_MODE_TOOLS.filter((name) =>
          enabledBuiltinNames.includes(name),
        ),
      ),
    );
    expect(allowed?.has("write")).toBe(false);
    expect(allowed?.has(options.deniedTool)).toBe(false);
  }

  it("returns undefined in execute mode without skill scopes", () => {
    expect(
      resolveEffectiveToolAllowlist({
        mode: "execute",
        skillScopes: [],
        enabledBuiltinNames,
        connectedMcpToolNames,
      }),
    ).toBeUndefined();
  });

  it("intersects skill scopes with enabled surface in execute mode", () => {
    const allowed = resolveEffectiveToolAllowlist({
      mode: "execute",
      skillScopes: [
        {
          invocationSource: "user",
          skillName: "review",
          skillRoot: "/tmp",
          skillFile: "/tmp/SKILL.md",
          allowedTools: ["read", "write", "mcp_search"],
        },
      ],
      enabledBuiltinNames,
      connectedMcpToolNames,
    });

    expect(allowed).toEqual(new Set(["read", "write", "mcp_search"]));
  });

  it("returns discover baseline without MCP or skill narrowing", () => {
    expectReadOnlyModeBaseline({
      mode: "discover",
      allowedTools: ["write"],
      deniedTool: "mcp_search",
    });
  });

  it("returns read/search/bash only in plan mode before approval", () => {
    expectReadOnlyModeBaseline({
      mode: "plan",
      allowedTools: ["read"],
      deniedTool: "edit",
    });
  });

  it("returns plan baseline with write/edit after approved save", () => {
    const allowed = resolveEffectiveToolAllowlist({
      mode: "plan",
      skillScopes: [
        {
          invocationSource: "user",
          skillName: "scope-lock",
          skillRoot: "/tmp",
          skillFile: "/tmp/SKILL.md",
          allowedTools: ["read"],
        },
      ],
      enabledBuiltinNames,
      connectedMcpToolNames,
      planFilePath: "/tmp/plan.md",
      planSaveApproved: true,
    });

    expect(allowed).toEqual(
      new Set(
        PLAN_MODE_TOOLS.filter((name) => enabledBuiltinNames.includes(name)),
      ),
    );
    expect(allowed?.has("write")).toBe(true);
    expect(allowed?.has("edit")).toBe(true);
    expect(allowed?.has("skill")).toBe(false);
    expect(allowed?.has("mcp_search")).toBe(false);
  });
});
