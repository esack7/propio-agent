import * as fs from "fs";
import * as path from "path";
import { FileSearchIndex } from "../../fileSearch/index.js";
import {
  makeWorkspace,
  writeWorkspaceFile,
} from "../../__tests__/workspaceTestHelpers.js";
import { acceptTypeaheadState, createTypeaheadState } from "../typeahead.js";

describe("typeahead", () => {
  function expectPathSuggestions(
    state: ReturnType<typeof createTypeaheadState>,
    expectedValues: string[],
  ): void {
    expect(state?.target.kind).toBe("path");
    expect(state?.suggestions.map((suggestion) => suggestion.value)).toEqual(
      expectedValues,
    );
  }

  it("detects slash command prefixes and filters concrete commands", () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");
    const state = createTypeaheadState({
      buffer: "/con",
      cursor: 4,
      workspaceRoot,
    });

    expect(state?.target.kind).toBe("command");
    expect(state?.suggestions.map((suggestion) => suggestion.value)).toEqual([
      "/context",
      "/context prompt",
      "/context memory",
    ]);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("includes /model in slash command suggestions", () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");
    const state = createTypeaheadState({
      buffer: "/mo",
      cursor: 3,
      workspaceRoot,
    });

    expect(state?.target.kind).toBe("command");
    expect(state?.suggestions.map((suggestion) => suggestion.value)).toEqual([
      "/model",
      "/mode",
      "/mode execute",
      "/mode plan",
      "/mode discover",
    ]);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("ignores slash commands that appear mid-sentence", () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");

    expect(
      createTypeaheadState({
        buffer: "please /con",
        cursor: "please /con".length,
        workspaceRoot,
      }),
    ).toMatchObject({
      suggestions: [],
    });

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("detects path-like tokens after file reference verbs", () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");
    writeWorkspaceFile(workspaceRoot, "src/ui/promptComposer.ts");

    const state = createTypeaheadState({
      buffer: "read src/ui/pro",
      cursor: "read src/ui/pro".length,
      workspaceRoot,
    });

    expectPathSuggestions(state, ["src/ui/promptComposer.ts"]);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("completes absolute paths when they stay inside the workspace", () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");
    writeWorkspaceFile(workspaceRoot, "docs/project.md");

    const absolutePrefix = path.join(workspaceRoot, "docs", "pro");
    const state = createTypeaheadState({
      buffer: `read ${absolutePrefix}`,
      cursor: `read ${absolutePrefix}`.length,
      workspaceRoot,
    });

    expectPathSuggestions(state, [
      path.join(workspaceRoot, "docs", "project.md"),
    ]);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("keeps dot-relative completions in dot-relative form", () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");
    writeWorkspaceFile(workspaceRoot, "docs/project.md");

    const state = createTypeaheadState({
      buffer: "read ./docs/pro",
      cursor: "read ./docs/pro".length,
      workspaceRoot,
    });

    expect(state?.suggestions.map((suggestion) => suggestion.value)).toEqual([
      "./docs/project.md",
    ]);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("replaces quoted partial paths without dropping the opening quote", () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");
    writeWorkspaceFile(workspaceRoot, "docs/project.md");

    const state = createTypeaheadState({
      buffer: 'read "docs/pro',
      cursor: 'read "docs/pro'.length,
      workspaceRoot,
    });

    expect(state).not.toBeNull();
    expect(acceptTypeaheadState(state!)).toEqual({
      buffer: 'read "docs/project.md',
      cursor: 'read "docs/project.md'.length,
    });

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("allows hidden entries only when the basename starts with a dot", () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");
    writeWorkspaceFile(workspaceRoot, ".secret");
    writeWorkspaceFile(workspaceRoot, "visible.txt");

    const visibleState = createTypeaheadState({
      buffer: "read v",
      cursor: "read v".length,
      workspaceRoot,
    });
    expect(
      visibleState?.suggestions.map((suggestion) => suggestion.value),
    ).toEqual(["visible.txt"]);

    const hiddenState = createTypeaheadState({
      buffer: "read .",
      cursor: "read .".length,
      workspaceRoot,
    });
    expect(
      hiddenState?.suggestions.map((suggestion) => suggestion.value),
    ).toContain(".secret");

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("sorts directories first, limits results, and skips ignored directories", () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");
    for (const directory of [
      "a-dir",
      "b-dir",
      ".hidden-dir",
      ".git",
      "node_modules",
      "dist",
      "coverage",
      ".propio",
    ]) {
      fs.mkdirSync(path.join(workspaceRoot, directory), { recursive: true });
    }

    for (const fileName of [
      "a-file.txt",
      "b-file.txt",
      "c-file.txt",
      "d-file.txt",
      "e-file.txt",
      "f-file.txt",
      "g-file.txt",
      "h-file.txt",
      "i-file.txt",
      "j-file.txt",
      "k-file.txt",
      "l-file.txt",
      "m-file.txt",
      "n-file.txt",
      "o-file.txt",
      "p-file.txt",
      "q-file.txt",
      "r-file.txt",
      "s-file.txt",
      "t-file.txt",
      "u-file.txt",
      "v-file.txt",
    ]) {
      writeWorkspaceFile(workspaceRoot, fileName);
    }

    const state = createTypeaheadState({
      buffer: "read ",
      cursor: "read ".length,
      workspaceRoot,
    });

    const values =
      state?.suggestions.map((suggestion) => suggestion.value) ?? [];
    expect(values.slice(0, 2)).toEqual(["a-dir/", "b-dir/"]);
    expect(values).not.toContain(".git/");
    expect(values).not.toContain("node_modules/");
    expect(values).not.toContain("dist/");
    expect(values).not.toContain("coverage/");
    expect(values).not.toContain(".propio/");
    expect(values).not.toContain(".hidden-dir/");
    expect(values.length).toBeLessThanOrEqual(20);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("returns no matches for relative path escape attempts", () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");

    expect(
      createTypeaheadState({
        buffer: "read ../",
        cursor: "read ../".length,
        workspaceRoot,
      }),
    ).toMatchObject({
      suggestions: [],
    });

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("returns no matches for absolute paths outside the workspace", () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");

    expect(
      createTypeaheadState({
        buffer: "read /etc/hos",
        cursor: "read /etc/hos".length,
        workspaceRoot,
      }),
    ).toMatchObject({
      suggestions: [],
    });

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("opens mention suggestions for bare @ tokens", async () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");
    writeWorkspaceFile(workspaceRoot, "src/agent.ts");
    writeWorkspaceFile(workspaceRoot, "docs/readme.md");
    const index = FileSearchIndex.forWorkspace(workspaceRoot);

    try {
      await index.refresh(true);
      const state = createTypeaheadState({
        buffer: "@",
        cursor: 1,
        workspaceRoot,
      });

      expect(state?.target.kind).toBe("mention");
      expect(state?.suggestions.map((suggestion) => suggestion.value)).toEqual(
        expect.arrayContaining(["@docs/", "@src/"]),
      );
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("accepts quoted mention suggestions with trailing spaces", async () => {
    const workspaceRoot = makeWorkspace("propio-typeahead-");
    writeWorkspaceFile(workspaceRoot, "docs/my file.md");
    const index = FileSearchIndex.forWorkspace(workspaceRoot);
    await index.refresh(true);

    const state = createTypeaheadState({
      buffer: '@"docs/my',
      cursor: '@"docs/my'.length,
      workspaceRoot,
    });

    expect(state?.target.kind).toBe("mention");
    expect(acceptTypeaheadState(state!)).toEqual({
      buffer: '@"docs/my file.md" ',
      cursor: '@"docs/my file.md" '.length,
    });

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
});
