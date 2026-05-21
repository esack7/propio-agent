import { compileSystemPrompt } from "../compileSystemPrompt.js";
import { formatRuntimeEnvironmentSection } from "../systemPromptSections.js";
import {
  buildEmptySystemPromptContext,
  SYSTEM_PROMPT_ENV_MAX_CHARS,
} from "../systemPromptContext.js";

describe("git overflow", () => {
  it("routes detailed git context to overflow when runtime section exceeds budget", () => {
    const longBranch = "feature/" + "x".repeat(SYSTEM_PROMPT_ENV_MAX_CHARS);
    const ctx = buildEmptySystemPromptContext({
      cwd: "/workspace",
      enabledToolNames: ["read"],
    });
    const bloated = {
      ...ctx,
      gitBranch: longBranch,
      isGitDirty: true,
    };

    const full = formatRuntimeEnvironmentSection(bloated);
    expect(full.length).toBeGreaterThan(SYSTEM_PROMPT_ENV_MAX_CHARS);

    const { compiled, runtimeContextOverflowBlock } =
      compileSystemPrompt(bloated);
    const runtime = compiled.sections.find(
      (s) => s.id === "runtimeEnvironment",
    );

    expect(runtime?.content.length).toBeLessThanOrEqual(
      SYSTEM_PROMPT_ENV_MAX_CHARS,
    );
    expect(runtime?.content).not.toContain(longBranch);
    expect(runtimeContextOverflowBlock).toBeDefined();
    expect(runtimeContextOverflowBlock).toContain(longBranch);
  });

  it("preserves enabled tool names in overflow when length is driven by many tools", () => {
    const toolNames = Array.from({ length: 400 }, (_, i) => `mcp_tool_${i}`);
    const ctx = buildEmptySystemPromptContext({
      cwd: "/workspace",
      enabledToolNames: toolNames,
    });

    const full = formatRuntimeEnvironmentSection(ctx);
    expect(full.length).toBeGreaterThan(SYSTEM_PROMPT_ENV_MAX_CHARS);

    const { compiled, runtimeContextOverflowBlock } = compileSystemPrompt(ctx);
    const runtime = compiled.sections.find(
      (s) => s.id === "runtimeEnvironment",
    );

    expect(runtime?.content.length).toBeLessThanOrEqual(
      SYSTEM_PROMPT_ENV_MAX_CHARS,
    );
    expect(runtime?.content).toMatch(/Enabled tools: 400 tools/);
    expect(runtimeContextOverflowBlock).toBeDefined();
    expect(runtimeContextOverflowBlock).toContain("mcp_tool_0");
    expect(runtimeContextOverflowBlock).toContain("mcp_tool_399");
  });
});
