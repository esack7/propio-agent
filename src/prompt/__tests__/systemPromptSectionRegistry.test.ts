import { compileSystemPrompt } from "../compileSystemPrompt.js";
import { buildEmptySystemPromptContext } from "../systemPromptContext.js";
import { SystemPromptSectionRegistry } from "../systemPromptSectionRegistry.js";

describe("SystemPromptSectionRegistry", () => {
  const ctx = buildEmptySystemPromptContext({ enabledToolNames: ["read"] });

  it("memoizes static sections across compiles", () => {
    const registry = new SystemPromptSectionRegistry();
    compileSystemPrompt(ctx, { baseRules: "Rules A" }, registry);
    const firstCore = registry.getCoreIdentity("Rules A");

    compileSystemPrompt(ctx, { baseRules: "Rules A" }, registry);
    const secondCore = registry.getCoreIdentity("Rules A");

    expect(secondCore).toBe(firstCore);
  });

  it("invalidates core identity cache when base rules change", () => {
    const registry = new SystemPromptSectionRegistry();
    compileSystemPrompt(ctx, { baseRules: "Rules A" }, registry);
    registry.invalidateCoreIdentity();
    compileSystemPrompt(ctx, { baseRules: "Rules B" }, registry);

    expect(registry.getCoreIdentity("Rules A")).toContain("Rules A");
    expect(registry.getCoreIdentity("Rules B")).toContain("Rules B");
  });

  it("refreshes runtime environment each compile", () => {
    const registry = new SystemPromptSectionRegistry();
    compileSystemPrompt(
      buildEmptySystemPromptContext({ cwd: "/a" }),
      {},
      registry,
    );
    const firstRuntime = registry.getLastRuntimeEnvironment();

    compileSystemPrompt(
      buildEmptySystemPromptContext({ cwd: "/b" }),
      {},
      registry,
    );
    const secondRuntime = registry.getLastRuntimeEnvironment();

    expect(firstRuntime).toContain("/a");
    expect(secondRuntime).toContain("/b");
    expect(secondRuntime).not.toBe(firstRuntime);
  });
});
