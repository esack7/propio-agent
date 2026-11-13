import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FindTool } from "../find.js";
import { GrepTool } from "../grep.js";
import { resolveToolPath } from "../shared.js";

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "search-")));
  workspace = path.join(root, "workspace");
  outside = path.join(root, "outside");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(outside, "deep"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src/a.txt"), "needle inside\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "needle outside\n");
  fs.writeFileSync(path.join(outside, "deep/x.txt"), "needle deep\n");
  // Links that leave the search root, and one that stays inside it.
  fs.symlinkSync(outside, path.join(workspace, "src/dirlink"));
  fs.symlinkSync(
    path.join(outside, "secret.txt"),
    path.join(workspace, "src/filelink.txt"),
  );
  fs.symlinkSync("a.txt", path.join(workspace, "src/inner.txt"));
  fs.symlinkSync(
    path.join(outside, "missing.txt"),
    path.join(workspace, "src/broken.txt"),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const options = {
  resolvePath: (rawPath: unknown) => resolveToolPath(rawPath, workspace),
};

describe("recursive searches stay under their root", () => {
  it("grep does not read through links that leave the root", async () => {
    const result = await new GrepTool(options).execute({
      path: "src",
      pattern: "needle",
    });

    expect(result).not.toContain("outside");
    expect(result).not.toContain("deep");
    expect(result.split("\n").sort()).toEqual([
      `${path.join(workspace, "src/a.txt")}:1:needle inside`,
      `${path.join(workspace, "src/inner.txt")}:1:needle inside`,
    ]);
  });

  it("find does not list files through links that leave the root", async () => {
    const result = await new FindTool(options).execute({
      path: "src",
      pattern: "*.txt",
    });

    expect(result.split("\n")).toEqual([
      path.join(workspace, "src/a.txt"),
      path.join(workspace, "src/inner.txt"),
    ]);
  });

  it("find does not descend into a linked directory for a nested pattern", async () => {
    const result = await new FindTool(options).execute({
      path: ".",
      pattern: "src/dirlink/**/*.txt",
    });

    expect(result).toBe(
      "No files found matching pattern: src/dirlink/**/*.txt",
    );
  });

  it("searches a root that is itself a link, which policy approved as its target", async () => {
    const result = await new GrepTool(options).execute({
      path: "src/dirlink",
      pattern: "needle",
    });

    expect(result).toContain("needle outside");
    expect(result).toContain("needle deep");
  });
});
