import { describe, expect, it } from "@jest/globals";
import {
  PolicyRuleError,
  parseRule,
  ruleMatches,
  type PolicyTarget,
  type RuleEffect,
} from "../rules.js";
import type { Capability } from "../capabilities.js";

const context = { workspaceRoot: "/work/project", homeDir: "/home/user" };

function matches(
  ruleText: string,
  effect: RuleEffect,
  toolName: string,
  target?: PolicyTarget,
  capabilities: readonly Capability[] = [],
): boolean {
  return ruleMatches(
    parseRule(ruleText),
    effect,
    { toolName, capabilities, target },
    context,
  );
}
const path = (value: string): PolicyTarget => ({ kind: "path", path: value });
const command = (value: string): PolicyTarget => ({
  kind: "command",
  command: value,
});

describe("parseRule", () => {
  it.each([
    ["read", { kind: "tool", name: "read" }],
    ["  bash  ", { kind: "tool", name: "bash" }],
    ["edit(src/**)", { kind: "tool", name: "edit", pattern: "src/**" }],
    [
      "bash(npm run test:*)",
      { kind: "tool", name: "bash", pattern: "npm run test:*" },
    ],
    [
      "bash(echo (nested))",
      { kind: "tool", name: "bash", pattern: "echo (nested)" },
    ],
    ["mcp__github", { kind: "tool", name: "mcp__github" }],
    [
      "mcp__github__create_issue",
      { kind: "tool", name: "mcp__github__create_issue" },
    ],
    [
      "capability:workspace_write",
      { kind: "capability", capability: "workspace_write" },
    ],
  ])("reads %s", (text, parsed) => {
    expect(parseRule(text)).toEqual({ text: text.trim(), parsed });
  });

  it.each([
    ["", 0, "must not be empty"],
    ["(src/**)", 0, "expected a tool name"],
    ["edit src", 4, 'expected "("'],
    ["edit(src/**", 11, 'expected a closing ")"'],
    ["edit()", 5, "must not be empty"],
    ["edit(src) extra", 15, 'expected a closing ")"'],
    ["capability:everything", 11, 'unknown capability "everything"'],
  ])("rejects %j with its position", (text, position, detail) => {
    let error: unknown;
    try {
      parseRule(text);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PolicyRuleError);
    expect(error).toMatchObject({ ruleText: text, position });
    expect((error as Error).message).toContain(detail);
  });

  it("rejects a rule that is not a string", () => {
    expect(() => parseRule(7)).toThrow(PolicyRuleError);
  });
});

describe("tool and capability rules", () => {
  it("match on the tool name alone", () => {
    expect(matches("read", "allow", "read")).toBe(true);
    expect(matches("read", "allow", "readme")).toBe(false);
    expect(matches("read", "allow", "write")).toBe(false);
  });

  it("match every tool of an MCP server by its prefix", () => {
    const target: PolicyTarget = { kind: "mcp", serverPrefix: "mcp__github" };
    expect(matches("mcp__github", "allow", "mcp__github__list", target)).toBe(
      true,
    );
    expect(
      matches("mcp__github__list", "allow", "mcp__github__list", target),
    ).toBe(true);
    expect(matches("mcp__git", "allow", "mcp__github__list", target)).toBe(
      false,
    );
    expect(
      matches("mcp__github__create", "allow", "mcp__github__list", target),
    ).toBe(false);
    // A prefix is only a server when the application says so.
    expect(matches("mcp__github", "allow", "mcp__github__list")).toBe(false);
  });

  it("match on a declared capability", () => {
    expect(
      matches("capability:process", "deny", "bash", undefined, ["process"]),
    ).toBe(true);
    expect(
      matches("capability:process", "deny", "read", undefined, ["read"]),
    ).toBe(false);
  });
});

describe("path patterns", () => {
  it.each([
    ["edit(src/**)", "/work/project/src/a/b.ts", true],
    ["edit(src/**)", "/work/project/test/a.ts", false],
    ["edit(src/**)", "/elsewhere/src/a.ts", false],
    ["edit(./src/*.ts)", "/work/project/src/a.ts", true],
    ["edit(./src/*.ts)", "/work/project/src/deep/a.ts", false],
    ["edit(**)", "/work/project/.env", true],
    ["edit(**)", "/etc/hosts", false],
    ["edit(/etc/**)", "/etc/hosts", true],
    ["edit(~/.ssh/**)", "/home/user/.ssh/id_rsa", true],
    ["edit(~/.ssh/**)", "/home/other/.ssh/id_rsa", false],
    ["edit(*.md)", "/work/project/README.md", true],
    ["edit(*.md)", "/work/project/docs/README.md", false],
  ])("%s against %s is %s", (rule, target, expected) => {
    expect(matches(rule, "allow", "edit", path(target))).toBe(expected);
    expect(matches(rule, "deny", "edit", path(target))).toBe(expected);
  });

  it("do not match a home pattern when no home directory is known", () => {
    expect(
      ruleMatches(
        parseRule("edit(~/.ssh/**)"),
        "deny",
        {
          toolName: "edit",
          capabilities: [],
          target: path("/home/user/.ssh/id_rsa"),
        },
        { workspaceRoot: "/work/project" },
      ),
    ).toBe(false);
  });

  it("apply to another tool only by name", () => {
    expect(
      matches("edit(src/**)", "deny", "write", path("/work/project/src/a")),
    ).toBe(false);
  });
});

describe("command patterns", () => {
  it.each([
    ["bash(npm test)", "npm test", true],
    ["bash(npm test)", "  npm test  ", true],
    ["bash(npm test)", "npm test --watch", false],
    ["bash(npm run test:*)", "npm run test", true],
    ["bash(npm run test:*)", "npm run test --watch", true],
    ["bash(npm run test:*)", "npm run tests", false],
    ["bash(npm run test:*)", "npm run test:unit", false],
    ["bash(git status:*)", "git status -sb", true],
    ["bash(git status:*)", "git stash", false],
  ])("%s against %j is %s", (rule, value, expected) => {
    expect(matches(rule, "allow", "bash", command(value))).toBe(expected);
  });

  it.each([
    "git status; rm -rf x",
    "git status && rm -rf x",
    "git status || rm -rf x",
    "git status | sh",
    "git status & rm -rf x",
    "git status\nrm -rf x",
    "git status `rm -rf x`",
    "git status $(rm -rf x)",
    "git status > /etc/passwd",
    "git status < input",
    "git status ';' quoted",
  ])("an allow rule never covers the compound command %j", (value) => {
    expect(matches("bash(git status:*)", "allow", "bash", command(value))).toBe(
      false,
    );
    expect(matches("bash(:*)", "allow", "bash", command(value))).toBe(false);
  });

  it.each([
    "git push",
    "git push origin main",
    "cd repo && git push",
    "true; git push --force",
    "echo ok | git push",
    "echo $(git push)",
    "echo `git push`",
    "(git push)",
    "true\ngit push",
  ])("a deny or ask rule finds its command inside %j", (value) => {
    expect(matches("bash(git push:*)", "deny", "bash", command(value))).toBe(
      true,
    );
    expect(matches("bash(git push:*)", "ask", "bash", command(value))).toBe(
      true,
    );
  });

  it("a command pattern never allows a detached call", () => {
    const detached: PolicyTarget = {
      kind: "command",
      command: "npm test",
      detached: true,
    };
    expect(matches("bash(npm test)", "allow", "bash", detached)).toBe(false);
    expect(matches("bash(npm:*)", "allow", "bash", detached)).toBe(false);
    // A whole-tool rule names no command, so it still applies.
    expect(matches("bash", "allow", "bash", detached)).toBe(true);
    // Deny and ask rules keep matching the command text.
    expect(matches("bash(npm test)", "deny", "bash", detached)).toBe(true);
    expect(matches("bash(npm test)", "ask", "bash", detached)).toBe(true);
  });

  it("a deny rule does not match an unrelated command", () => {
    expect(
      matches("bash(git push:*)", "deny", "bash", command("git pull && ls")),
    ).toBe(false);
  });
});

describe("a pattern with nothing to compare against", () => {
  it("still denies or asks, and never allows", () => {
    expect(matches("custom(anything)", "deny", "custom")).toBe(true);
    expect(matches("custom(anything)", "ask", "custom")).toBe(true);
    expect(matches("custom(anything)", "allow", "custom")).toBe(false);
  });
});

describe("root directories with glob characters", () => {
  const at = (workspaceRoot: string, homeDir?: string) => ({
    workspaceRoot,
    homeDir,
  });
  const matchesIn = (
    ruleText: string,
    target: string,
    root: { workspaceRoot: string; homeDir?: string },
  ) =>
    ruleMatches(
      parseRule(ruleText),
      "allow",
      { toolName: "edit", capabilities: [], target: path(target) },
      root,
    );

  it.each([
    ["/work/draft[1]", "/work/draft[1]/example.txt", true],
    ["/work/draft[1]", "/work/draft1/example.txt", false],
    ["/work/draft*", "/work/draft*/example.txt", true],
    ["/work/draft*", "/work/draft1/example.txt", false],
    ["/work/{a,b}", "/work/{a,b}/example.txt", true],
    ["/work/{a,b}", "/work/a/example.txt", false],
    ["/work/what?", "/work/whatx/example.txt", false],
  ])("a relative rule under %s against %s is %s", (root, target, expected) => {
    expect(matchesIn("edit(example.txt)", target, at(root))).toBe(expected);
    expect(matchesIn("edit(**)", target, at(root))).toBe(expected);
  });

  it("keeps the glob in the rule itself working under such a root", () => {
    expect(
      matchesIn("edit(src/*.ts)", "/work/draft*/src/a.ts", at("/work/draft*")),
    ).toBe(true);
    expect(
      matchesIn("edit(src/*.ts)", "/work/draft1/src/a.ts", at("/work/draft*")),
    ).toBe(false);
  });

  it("treats the home directory literally for ~/ rules", () => {
    const root = at("/work/project", "/home/a{b,c}");
    expect(matchesIn("edit(~/.ssh/**)", "/home/a{b,c}/.ssh/id", root)).toBe(
      true,
    );
    expect(matchesIn("edit(~/.ssh/**)", "/home/ab/.ssh/id", root)).toBe(false);
  });
});
