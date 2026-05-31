import * as fs from "fs";
import { spawn } from "child_process";
import { FileSearchIndex } from "../fileSearchIndex.js";
import {
  makeWorkspace,
  writeWorkspaceFile,
} from "../../__tests__/workspaceTestHelpers.js";

describe("FileSearchIndex", () => {
  it("returns top-level entries for empty queries", async () => {
    const workspaceRoot = makeWorkspace("propio-file-index-");
    writeWorkspaceFile(workspaceRoot, "src/agent.ts");
    writeWorkspaceFile(workspaceRoot, "docs/readme.md");

    const index = new FileSearchIndex(workspaceRoot);
    await index.refresh(true);
    const results = index.search("");

    expect(results.map((result) => result.path)).toEqual(
      expect.arrayContaining(["src/", "docs/"]),
    );

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("favors exact case matches and downranks test files", async () => {
    const workspaceRoot = makeWorkspace("propio-file-index-");
    writeWorkspaceFile(workspaceRoot, "src/Agent.ts");
    writeWorkspaceFile(workspaceRoot, "src/agent.test.ts");

    const index = new FileSearchIndex(workspaceRoot);
    await index.refresh(true);

    const caseSensitive = index.search("Agent");
    expect(caseSensitive[0]?.path).toBe("src/Agent.ts");

    const lowerCase = index.search("agent");
    expect(lowerCase[0]?.path).toBe("src/Agent.ts");
    expect(lowerCase.map((result) => result.path)).toContain(
      "src/agent.test.ts",
    );

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("includes directory entries in fuzzy search results", async () => {
    const workspaceRoot = makeWorkspace("propio-file-index-");
    writeWorkspaceFile(workspaceRoot, "src/utils/helpers.ts");

    const index = new FileSearchIndex(workspaceRoot);
    await index.refresh(true);
    const results = index.search("util");

    expect(results.map((result) => result.path)).toContain("src/utils/");

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("keeps retrying refreshes while the index is empty", async () => {
    const workspaceRoot = makeWorkspace("propio-file-index-");
    const index = new FileSearchIndex(workspaceRoot);
    const refreshSpy = jest.spyOn(index, "refresh");

    expect(index.search("src")).toEqual([]);
    expect(refreshSpy).toHaveBeenCalledWith(true);

    refreshSpy.mockRestore();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("opportunistically refreshes warm indexes during search", async () => {
    const workspaceRoot = makeWorkspace("propio-file-index-");
    writeWorkspaceFile(workspaceRoot, "src/agent.ts");

    const index = new FileSearchIndex(workspaceRoot);
    await index.refresh(true);
    const refreshSpy = jest.spyOn(index, "refresh");

    index.search("agent");

    expect(refreshSpy).toHaveBeenCalledWith();

    refreshSpy.mockRestore();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("builds entries from git without requiring rg fallback", async () => {
    const workspaceRoot = makeWorkspace("propio-file-index-");
    writeWorkspaceFile(workspaceRoot, "src/agent.ts");

    await run("git", ["init"], workspaceRoot);
    await run("git", ["add", "src/agent.ts"], workspaceRoot);

    const index = new FileSearchIndex(workspaceRoot);
    await index.refresh(true);

    expect(index.search("sr").map((result) => result.path)).toContain("src/");

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}
