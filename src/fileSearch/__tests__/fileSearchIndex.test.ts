import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { FileSearchIndex } from "../fileSearchIndex.js";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "propio-file-index-"));
}

function writeFile(root: string, relativePath: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, "test");
}

describe("FileSearchIndex", () => {
  it("returns top-level entries for empty queries", async () => {
    const workspaceRoot = makeWorkspace();
    writeFile(workspaceRoot, "src/agent.ts");
    writeFile(workspaceRoot, "docs/readme.md");

    const index = new FileSearchIndex(workspaceRoot);
    await index.refresh(true);
    const results = index.search("");

    expect(results.map((result) => result.path)).toEqual(
      expect.arrayContaining(["src/", "docs/"]),
    );

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("favors exact case matches and downranks test files", async () => {
    const workspaceRoot = makeWorkspace();
    writeFile(workspaceRoot, "src/Agent.ts");
    writeFile(workspaceRoot, "src/agent.test.ts");

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
    const workspaceRoot = makeWorkspace();
    writeFile(workspaceRoot, "src/utils/helpers.ts");

    const index = new FileSearchIndex(workspaceRoot);
    await index.refresh(true);
    const results = index.search("util");

    expect(results.map((result) => result.path)).toContain("src/utils/");

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("keeps retrying refreshes while the index is empty", async () => {
    const workspaceRoot = makeWorkspace();
    const index = new FileSearchIndex(workspaceRoot);
    const refreshSpy = jest.spyOn(index, "refresh");

    expect(index.search("src")).toEqual([]);
    expect(refreshSpy).toHaveBeenCalledWith(true);

    refreshSpy.mockRestore();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("builds entries from git without requiring rg fallback", async () => {
    const workspaceRoot = makeWorkspace();
    writeFile(workspaceRoot, "src/agent.ts");

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
