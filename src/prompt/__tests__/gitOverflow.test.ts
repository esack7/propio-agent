import { compileSystemPrompt } from "../compileSystemPrompt.js";
import { formatRuntimeEnvironmentSection } from "../systemPromptSections.js";
import {
  buildEmptySystemPromptContext,
  SYSTEM_PROMPT_ENV_MAX_CHARS,
} from "../systemPromptContext.js";
import type { SystemPromptContext } from "../systemPromptContext.js";

function expectRuntimeEnvOverflow(
  ctx: SystemPromptContext,
): ReturnType<typeof compileSystemPrompt> {
  const result = compileSystemPrompt(ctx);
  const runtime = result.compiled.sections.find(
    (s) => s.id === "runtimeEnvironment",
  );

  expect(runtime?.content.length).toBeLessThanOrEqual(
    SYSTEM_PROMPT_ENV_MAX_CHARS,
  );
  expect(result.runtimeContextOverflowBlock).toBeDefined();
  return result;
}

describe("git overflow", () => {
  it("routes detailed git context to overflow when runtime section exceeds budget", () => {
    const longBranch = "feature/" + "x".repeat(SYSTEM_PROMPT_ENV_MAX_CHARS);
    const bloated = {
      ...buildEmptySystemPromptContext({
        cwd: "/workspace",
        enabledToolNames: ["read"],
      }),
      gitBranch: longBranch,
      isGitDirty: true,
    };

    expect(formatRuntimeEnvironmentSection(bloated).length).toBeGreaterThan(
      SYSTEM_PROMPT_ENV_MAX_CHARS,
    );

    const { compiled, runtimeContextOverflowBlock } =
      expectRuntimeEnvOverflow(bloated);
    const runtime = compiled.sections.find(
      (s) => s.id === "runtimeEnvironment",
    );

    expect(runtime?.content).not.toContain(longBranch);
    expect(runtimeContextOverflowBlock).toContain(longBranch);
  });

  it("preserves enabled tool names in overflow when length is driven by many tools", () => {
    const toolNames = Array.from({ length: 400 }, (_, i) => `mcp_tool_${i}`);
    const ctx = buildEmptySystemPromptContext({
      cwd: "/workspace",
      enabledToolNames: toolNames,
    });

    expect(formatRuntimeEnvironmentSection(ctx).length).toBeGreaterThan(
      SYSTEM_PROMPT_ENV_MAX_CHARS,
    );

    const { compiled, runtimeContextOverflowBlock } =
      expectRuntimeEnvOverflow(ctx);
    const runtime = compiled.sections.find(
      (s) => s.id === "runtimeEnvironment",
    );

    expect(runtime?.content).toMatch(/Enabled tools: 400 tools/);
    expect(runtimeContextOverflowBlock).toContain("mcp_tool_0");
    expect(runtimeContextOverflowBlock).toContain("mcp_tool_399");
  });
});
