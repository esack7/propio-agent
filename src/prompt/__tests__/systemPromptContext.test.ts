import {
  buildEmptySystemPromptContext,
  buildSystemPromptContext,
  resetGitCacheForTests,
  seedGitCacheForTests,
} from "../systemPromptContext.js";

describe("systemPromptContext", () => {
  beforeEach(() => {
    resetGitCacheForTests();
  });

  it("includes stable environment fields", () => {
    const ctx = buildEmptySystemPromptContext({
      cwd: "/tmp/workspace",
      enabledToolNames: ["read", "bash"],
    });

    expect(ctx.cwd).toBe("/tmp/workspace");
    expect(ctx.os).toContain(process.platform);
    expect(ctx.nodeVersion).toBe(process.version);
    expect(ctx.dateTime).toMatch(/UTC[+-]\d{2}:\d{2}\)$/);
    expect(ctx.enabledToolNames).toEqual(["read", "bash"]);
  });

  it("omits git fields when not in a repository", () => {
    const ctx = buildSystemPromptContext({
      cwd: "/tmp/nonexistent-propio-git-path-xyz",
    });

    expect(ctx.gitBranch).toBeUndefined();
    expect(ctx.isGitDirty).toBeUndefined();
  });

  it("uses cached git state within TTL for the same cwd", () => {
    const cwd = process.cwd();
    const first = buildSystemPromptContext({ cwd });
    const second = buildSystemPromptContext({ cwd });

    if (first.gitBranch !== undefined) {
      expect(second.gitBranch).toBe(first.gitBranch);
      expect(second.isGitDirty).toBe(first.isGitDirty);
    }
  });

  it("does not reuse git cache across different cwd values within TTL", () => {
    seedGitCacheForTests("/repo-a", { branch: "branch-a", isDirty: false });
    seedGitCacheForTests("/repo-b", { branch: "branch-b", isDirty: true });

    const a = buildSystemPromptContext({ cwd: "/repo-a" });
    const b = buildSystemPromptContext({ cwd: "/repo-b" });

    expect(a.gitBranch).toBe("branch-a");
    expect(a.isGitDirty).toBe(false);
    expect(b.gitBranch).toBe("branch-b");
    expect(b.isGitDirty).toBe(true);
  });
});
