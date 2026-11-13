import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveToolPath } from "../../tools/shared.js";
import { resolvePolicyTarget, resolveSymbolicLinks } from "../targets.js";

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "targets-")));
  workspace = path.join(root, "workspace");
  outside = path.join(root, "outside");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function target(toolName: string, args: Record<string, unknown>) {
  return resolvePolicyTarget(toolName, args, {
    workspaceRoot: workspace,
    resolvePath: (rawPath) => resolveToolPath(rawPath, workspace),
  });
}

describe("file tool targets", () => {
  it.each(["read", "write", "edit", "grep", "find", "ls"])(
    "%s acts on its resolved path",
    (toolName) => {
      expect(target(toolName, { path: "src/../src/a.ts" })).toEqual({
        kind: "path",
        path: path.join(workspace, "src/a.ts"),
      });
    },
  );

  it("follows a link that leaves the workspace", () => {
    fs.symlinkSync(outside, path.join(workspace, "link"));

    expect(target("read", { path: "link/secret.txt" })).toEqual({
      kind: "path",
      path: path.join(outside, "secret.txt"),
    });
  });

  it("places a file that does not exist yet under its real parent", () => {
    fs.symlinkSync(outside, path.join(workspace, "link"));

    expect(target("write", { path: "link/new/deep.txt" })).toEqual({
      kind: "path",
      path: path.join(outside, "new/deep.txt"),
    });
    expect(target("write", { path: "src/new.txt" })).toEqual({
      kind: "path",
      path: path.join(workspace, "src/new.txt"),
    });
  });

  it("refuses a link whose destination is missing", () => {
    fs.symlinkSync(
      path.join(outside, "not-there.txt"),
      path.join(workspace, "dangling"),
    );

    expect(() => target("write", { path: "dangling" })).toThrow(
      /symbolic link to a missing path/,
    );
  });

  it("rejects a path the tool itself would reject", () => {
    expect(() => target("read", { path: "" })).toThrow(/non-empty string/);
  });
});

describe("resolveSymbolicLinks", () => {
  it("returns an existing path through its links", () => {
    fs.symlinkSync(outside, path.join(workspace, "link"));
    expect(resolveSymbolicLinks(path.join(workspace, "link"))).toBe(outside);
  });
});

describe("command targets", () => {
  it("is the command text when it runs in the workspace", () => {
    expect(target("bash", { command: "npm test" })).toEqual({
      kind: "command",
      command: "npm test",
    });
    expect(
      target("bash", { command: "npm test", cwd: "src", env: {} }),
    ).toEqual({ kind: "command", command: "npm test" });
  });

  it("is detached when the working directory is outside the workspace", () => {
    expect(target("bash", { command: "npm test", cwd: outside })).toEqual({
      kind: "command",
      command: "npm test",
      detached: true,
    });
    expect(target("bash", { command: "npm test", cwd: ".." })).toMatchObject({
      detached: true,
    });
  });

  it("is detached when the working directory is a link out of the workspace", () => {
    fs.symlinkSync(outside, path.join(workspace, "link"));
    expect(target("bash", { command: "npm test", cwd: "link" })).toMatchObject({
      detached: true,
    });
  });

  it("is detached when the call sets environment variables", () => {
    expect(
      target("bash", { command: "npm test", env: { NODE_ENV: "production" } }),
    ).toEqual({ kind: "command", command: "npm test", detached: true });
  });
});

describe("other targets", () => {
  it("names the MCP server by its normalized prefix", () => {
    expect(
      resolvePolicyTarget(
        "mcp__my_server__create_issue",
        {},
        {
          workspaceRoot: workspace,
          resolvePath: (rawPath) => resolveToolPath(rawPath, workspace),
          mcpServerName: "My Server",
        },
      ),
    ).toEqual({ kind: "mcp", serverPrefix: "mcp__my_server" });
  });

  it("gives a tool it does not know no target", () => {
    expect(target("skill", { name: "x" })).toBeUndefined();
  });
});
