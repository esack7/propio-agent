import {
  compileSystemPrompt,
  DEFAULT_CORE_IDENTITY,
  joinSections,
} from "../compileSystemPrompt.js";
import { buildEmptySystemPromptContext } from "../systemPromptContext.js";

describe("compileSystemPrompt", () => {
  const ctx = buildEmptySystemPromptContext({
    cwd: "/workspace",
    enabledToolNames: ["read", "grep", "mcp_search"],
  });

  it("returns sections in stable order", () => {
    const { compiled } = compileSystemPrompt(ctx, {
      agentsMdContent: "Run format:check before commit.",
      baseRules: "Custom core rules.",
    });

    expect(compiled.sections.map((s) => s.id)).toEqual([
      "coreIdentity",
      "agentsMd",
      "toolUtilization",
      "responseFormatting",
      "runtimeEnvironment",
    ]);
  });

  it("includes scratchpadDirectory when scratchpadDir is set", () => {
    const scratchpadDir = "/tmp/propio-scratchpads/test-session";
    const { compiled } = compileSystemPrompt({
      ...ctx,
      scratchpadDir,
    });

    expect(compiled.sections.map((s) => s.id)).toEqual([
      "coreIdentity",
      "toolUtilization",
      "responseFormatting",
      "scratchpadDirectory",
      "runtimeEnvironment",
    ]);
    const scratch = compiled.sections.find(
      (s) => s.id === "scratchpadDirectory",
    );
    expect(scratch?.content).toContain(scratchpadDir);
    expect(scratch?.content).toContain("# Scratchpad Directory");
  });

  it("omits scratchpadDirectory when scratchpadDir is unset", () => {
    const { compiled } = compileSystemPrompt(ctx);
    expect(compiled.sections.map((s) => s.id)).not.toContain(
      "scratchpadDirectory",
    );
  });

  it("omits agentsMd when content is blank", () => {
    const { compiled } = compileSystemPrompt(ctx, {
      agentsMdContent: "   ",
      baseRules: DEFAULT_CORE_IDENTITY,
    });

    expect(compiled.sections.map((s) => s.id)).not.toContain("agentsMd");
  });

  it("lists enabled tools in runtime environment", () => {
    const { compiled } = compileSystemPrompt(ctx);
    const runtime = compiled.sections.find(
      (s) => s.id === "runtimeEnvironment",
    );

    expect(runtime?.content).toContain("grep");
    expect(runtime?.content).toContain("mcp_search");
    expect(runtime?.content).toContain("Enabled tools:");
  });

  it("joinSections produces double-newline separated markdown blocks", () => {
    const { compiled } = compileSystemPrompt(ctx, {
      agentsMdContent: "Project rules.",
    });
    const joined = joinSections(compiled);

    expect(joined).toContain("# Core Identity and Operational Rules");
    expect(joined).toContain("# Project Instructions (AGENTS.md)");
    expect(joined).toContain("# Runtime Environment");
    expect(joined.split("\n\n# ").length).toBeGreaterThanOrEqual(4);
  });
});
