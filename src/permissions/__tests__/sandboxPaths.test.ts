import { describe, expect, it } from "@jest/globals";
import {
  createHostPathTranslator,
  isHostPathRule,
  readHostPaths,
  unappliableHostRule,
} from "../sandboxPaths.js";

describe("readHostPaths", () => {
  it("reads both paths the wrapper passes", () => {
    expect(
      readHostPaths({
        PROPIO_SANDBOX_HOST_WORKSPACE: "/Users/me/proj/",
        PROPIO_SANDBOX_HOST_HOME: "/Users/me",
      }),
    ).toEqual({ workspace: "/Users/me/proj/", home: "/Users/me" });
  });

  it.each([
    [{}],
    [{ PROPIO_SANDBOX_HOST_WORKSPACE: "/Users/me/proj" }],
    [{ PROPIO_SANDBOX_HOST_HOME: "/Users/me" }],
    [
      {
        PROPIO_SANDBOX_HOST_WORKSPACE: "proj",
        PROPIO_SANDBOX_HOST_HOME: "/Users/me",
      },
    ],
    [
      {
        PROPIO_SANDBOX_HOST_WORKSPACE: "/Users/me/proj",
        PROPIO_SANDBOX_HOST_HOME: "",
      },
    ],
  ])(
    "is unknown for %j: a guess could point rules at the wrong files",
    (env) => {
      expect(readHostPaths(env)).toBeUndefined();
    },
  );
});

describe("createHostPathTranslator", () => {
  const toHost = createHostPathTranslator("/workspace", "/Users/me/proj");

  it.each([
    ["/workspace", "/Users/me/proj"],
    ["/workspace/src/a.ts", "/Users/me/proj/src/a.ts"],
    ["/workspace/.env", "/Users/me/proj/.env"],
  ])("names %s as the host does: %s", (container, host) => {
    expect(toHost(container)).toBe(host);
  });

  it.each(["/etc/hosts", "/root/.ssh/id", "/workspace-other/a", "/tmp/x"])(
    "leaves %s, which only the container has, as it is",
    (container) => {
      expect(toHost(container)).toBe(container);
    },
  );

  it.each(["/Users/me/proj", "/Users/me/proj/secrets/key"])(
    "refuses %s: in the container that is not the host's project",
    (container) => {
      expect(() => toHost(container)).toThrow(/is not the host directory/);
    },
  );

  it("is the identity when both sides use the same path", () => {
    const same = createHostPathTranslator("/work/proj", "/work/proj");
    expect(same("/work/proj/a")).toBe("/work/proj/a");
  });
});

describe("rules written with host paths", () => {
  it.each([
    "write(/Users/me/proj/secrets/**)",
    "read(~/.ssh/**)",
    "edit(~)",
    "grep(/**/private/**)",
  ])("%s is one", (rule) => {
    expect(isHostPathRule(rule)).toBe(true);
  });

  it.each([
    "write(secrets/**)",
    "write",
    "bash(/bin/rm:*)",
    "bash(~/bin/tool:*)",
    "capability:workspace_write",
    "mcp__github",
  ])("%s is not", (rule) => {
    expect(isHostPathRule(rule)).toBe(false);
  });

  it("stops on a deny or ask rule that needs the host paths, naming it", () => {
    expect(
      unappliableHostRule([
        { effect: "allow", rule: "read(/Users/me/notes/**)" },
        { effect: "deny", rule: "write(secrets/**)" },
        { effect: "ask", rule: "edit(~/proj/config/**)" },
      ]),
    ).toMatch(
      /Cannot apply the ask rule "edit\(~\/proj\/config\/\*\*\)" in sandbox mode.*PROPIO_SANDBOX_HOST_WORKSPACE/,
    );
    expect(
      unappliableHostRule([
        { effect: "deny", rule: "write(/Users/me/proj/secrets/**)" },
      ]),
    ).toMatch(/Cannot apply the deny rule/);
  });

  it("does not stop on allow rules or rules that need no host path", () => {
    expect(
      unappliableHostRule([
        { effect: "allow", rule: "read(/Users/me/notes/**)" },
        { effect: "deny", rule: "write(secrets/**)" },
        { effect: "deny", rule: "bash(/bin/rm:*)" },
        { effect: "ask", rule: "capability:process" },
      ]),
    ).toBeUndefined();
  });
});
