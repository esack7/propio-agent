import { describe, expect, it } from "@jest/globals";
import {
  ApprovalAnswerError,
  getPreset,
  InMemoryPermissionStore,
  PolicyEngine,
  PolicyRuleError,
  UNDECLARED_TOOL_METADATA,
  listPresets,
  type ApprovalRequest,
  type PermissionSettings,
  type PermissionSettingsChange,
  type PermissionStore,
  type PolicyDecision,
  type PolicyEngineOptions,
  type PolicyRequest,
  type ToolMetadata,
} from "../index.js";

const WORKSPACE = "/work/project";
const OWNER = "owner-a";

const READ: ToolMetadata = {
  capabilities: ["read"],
  readOnly: true,
  concurrencySafe: true,
};
const WRITE: ToolMetadata = {
  capabilities: ["workspace_write"],
  readOnly: false,
  concurrencySafe: false,
};
const PROCESS: ToolMetadata = {
  capabilities: ["process"],
  readOnly: false,
  concurrencySafe: false,
};
const NETWORK: ToolMetadata = {
  capabilities: ["network"],
  readOnly: true,
  concurrencySafe: true,
};

/** One call of every kind the built-in and MCP tools produce. */
const CALLS = {
  readInside: fileCall("read", READ, `${WORKSPACE}/src/a.ts`),
  readOutside: fileCall("read", READ, "/etc/hosts"),
  grepInside: fileCall("grep", READ, `${WORKSPACE}/src`),
  findInside: fileCall("find", READ, WORKSPACE),
  lsInside: fileCall("ls", READ, `${WORKSPACE}/docs`),
  writeInside: fileCall("write", WRITE, `${WORKSPACE}/src/a.ts`),
  editInside: fileCall("edit", WRITE, `${WORKSPACE}/src/a.ts`),
  writeOutside: fileCall("write", WRITE, "/tmp/out.txt"),
  bash: {
    toolName: "bash",
    args: { command: "npm test" },
    metadata: PROCESS,
    target: { kind: "command", command: "npm test" },
  },
  mcp: {
    toolName: "mcp__github__create_issue",
    args: { title: "x" },
    metadata: UNDECLARED_TOOL_METADATA,
    target: { kind: "mcp", serverPrefix: "mcp__github" },
  },
  fetch: { toolName: "fetch", args: { url: "https://x" }, metadata: NETWORK },
  skill: { toolName: "skill", args: { name: "x" }, metadata: READ },
} satisfies Record<string, PolicyRequest>;

type CallName = keyof typeof CALLS;

function fileCall(
  toolName: string,
  metadata: ToolMetadata,
  path: string,
): PolicyRequest {
  return { toolName, args: { path }, metadata, target: { kind: "path", path } };
}

async function engine(
  settings: Partial<PermissionSettings> = {},
  options: Partial<PolicyEngineOptions> = {},
): Promise<{ engine: PolicyEngine; store: InMemoryPermissionStore }> {
  const store = new InMemoryPermissionStore({
    [OWNER]: { allow: [], ask: [], deny: [], ...settings },
  });
  return {
    store,
    engine: await PolicyEngine.create({
      store,
      owner: OWNER,
      workspaceRoot: WORKSPACE,
      homeDir: "/home/user",
      ...options,
    }),
  };
}

function outcomes(policy: PolicyEngine): Record<CallName, string> {
  return Object.fromEntries(
    Object.entries(CALLS).map(([name, call]) => [
      name,
      policy.evaluate(call).outcome,
    ]),
  ) as Record<CallName, string>;
}

function asked(decision: PolicyDecision): ApprovalRequest {
  if (decision.outcome !== "ask") {
    throw new Error(`expected ask, got ${decision.outcome}`);
  }
  return decision.request;
}

describe("presets", () => {
  // The whole behavior of each preset, stated call by call.
  const expected: Record<string, Record<CallName, string>> = {
    "read-only": {
      readInside: "allow",
      readOutside: "ask",
      grepInside: "allow",
      findInside: "allow",
      lsInside: "allow",
      writeInside: "deny",
      editInside: "deny",
      writeOutside: "deny",
      bash: "deny",
      mcp: "deny",
      fetch: "deny",
      skill: "allow",
    },
    ask: {
      readInside: "allow",
      readOutside: "ask",
      grepInside: "allow",
      findInside: "allow",
      lsInside: "allow",
      writeInside: "ask",
      editInside: "ask",
      writeOutside: "ask",
      bash: "ask",
      mcp: "ask",
      fetch: "ask",
      skill: "allow",
    },
    "accept-edits": {
      readInside: "allow",
      readOutside: "ask",
      grepInside: "allow",
      findInside: "allow",
      lsInside: "allow",
      writeInside: "allow",
      editInside: "allow",
      writeOutside: "ask",
      bash: "ask",
      mcp: "ask",
      fetch: "ask",
      skill: "allow",
    },
    bypass: {
      readInside: "allow",
      readOutside: "allow",
      grepInside: "allow",
      findInside: "allow",
      lsInside: "allow",
      writeInside: "allow",
      editInside: "allow",
      writeOutside: "allow",
      bash: "allow",
      mcp: "allow",
      fetch: "allow",
      skill: "allow",
    },
  };

  it("has an expectation for every preset that exists", () => {
    expect(
      listPresets()
        .map((preset) => preset.name)
        .sort(),
    ).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.keys(expected))(
    "%s allows, asks about, and denies exactly these calls",
    async (preset) => {
      const fromSettings = await engine({ preset });
      const fromOption = await engine({}, { preset });

      expect(outcomes(fromSettings.engine)).toEqual(expected[preset]);
      expect(outcomes(fromOption.engine)).toEqual(expected[preset]);
      expect(fromSettings.engine.describe().preset).toBe(preset);
    },
  );

  it("starts in ask when nothing is configured", async () => {
    const policy = await PolicyEngine.create({
      store: new InMemoryPermissionStore(),
      owner: "nobody",
      workspaceRoot: WORKSPACE,
    });

    expect(policy.describe()).toEqual({
      preset: "ask",
      mode: "ask",
      rules: [],
    });
    expect(outcomes(policy)).toEqual(expected.ask);
  });

  it("prefers the option over the stored preset", async () => {
    const { engine: policy } = await engine(
      { preset: "bypass" },
      { preset: "read-only" },
    );
    expect(policy.describe().preset).toBe("read-only");
  });

  it("layers user rules on top of a preset", async () => {
    const { engine: policy } = await engine({
      preset: "accept-edits",
      allow: ["bash(npm test)"],
      deny: ["edit(src/**)"],
    });

    expect(policy.evaluate(CALLS.bash).outcome).toBe("allow");
    expect(policy.evaluate(CALLS.editInside).outcome).toBe("deny");
    expect(policy.evaluate(CALLS.writeInside).outcome).toBe("allow");
  });

  it("rejects an unknown preset from either source", async () => {
    await expect(engine({ preset: "yolo" })).rejects.toThrow(
      'Unknown permission preset "yolo"',
    );
    await expect(engine({}, { preset: "yolo" })).rejects.toThrow(
      'Unknown permission preset "yolo"',
    );
  });

  it("lets a mode override the preset's mode without changing its rules", async () => {
    const { engine: policy } = await engine(
      { preset: "read-only" },
      { mode: "bypass" },
    );

    expect(policy.mode).toBe("bypass");
    expect(policy.evaluate(CALLS.readOutside).outcome).toBe("allow");
    expect(policy.evaluate(CALLS.bash).outcome).toBe("deny");
  });
});

describe("precedence", () => {
  it("deny beats ask, and ask beats allow, whatever the order written", async () => {
    const { engine: policy } = await engine({
      allow: ["bash", "edit"],
      ask: ["bash(npm test)", "edit(src/**)"],
      deny: ["edit(src/a.ts)"],
    });

    expect(policy.evaluate(CALLS.bash)).toMatchObject({
      outcome: "ask",
      rule: "bash(npm test)",
      source: "user",
    });
    expect(policy.evaluate(CALLS.editInside)).toMatchObject({
      outcome: "deny",
      rule: "edit(src/a.ts)",
      actor: "application",
    });
  });

  it.each(["read-only", "ask", "accept-edits", "bypass"])(
    "a deny rule is not overridden by the %s preset, an allow rule, or a session grant",
    async (preset) => {
      const { engine: policy } = await engine({
        preset,
        allow: ["read", "read(src/**)", "capability:read"],
        deny: ["read(src/a.ts)"],
      });
      policy.addSessionGrant("read");
      policy.addSessionGrant("read(src/a.ts)");
      policy.addSessionGrant("capability:read");

      expect(policy.evaluate(CALLS.readInside)).toMatchObject({
        outcome: "deny",
        rule: "read(src/a.ts)",
      });
    },
  );

  it("reports the mode when no rule matched", async () => {
    const { engine: policy } = await engine();
    expect(policy.evaluate(CALLS.readInside)).toMatchObject({
      outcome: "allow",
      rule: "mode:ask",
      source: "mode",
      actor: "application",
    });
  });
});

describe("mode defaults", () => {
  it("asks for a write that names no path, even in accept-edits", async () => {
    const { engine: policy } = await engine({ preset: "accept-edits" });
    expect(
      policy.evaluate({ toolName: "patch", args: {}, metadata: WRITE }).outcome,
    ).toBe("ask");
  });

  it("asks for a tool that declares no capabilities", async () => {
    const { engine: policy } = await engine();
    const metadata = {
      capabilities: [],
      readOnly: true,
      concurrencySafe: true,
    };
    expect(
      policy.evaluate({ toolName: "odd", args: {}, metadata }).outcome,
    ).toBe("ask");
  });

  it("does not treat a sibling directory as inside the workspace", async () => {
    const { engine: policy } = await engine();
    expect(
      policy.evaluate(fileCall("read", READ, "/work/project-other/a")).outcome,
    ).toBe("ask");
    expect(policy.evaluate(fileCall("read", READ, WORKSPACE)).outcome).toBe(
      "allow",
    );
  });
});

describe("loading rules", () => {
  it("fails on a rule that cannot be read, naming it and the position", async () => {
    await expect(engine({ deny: ["edit(src/**"] })).rejects.toMatchObject({
      name: "PolicyRuleError",
      ruleText: "edit(src/**",
      position: 11,
    });
    await expect(engine({ allow: ["ok", "capability:x"] })).rejects.toThrow(
      PolicyRuleError,
    );
  });

  it("refuses a home pattern it could never match", async () => {
    await expect(
      engine({ deny: ["read(~/.ssh/**)"] }, { homeDir: undefined }),
    ).rejects.toThrow("uses ~ but no home directory was provided");
  });

  it("requires absolute roots", async () => {
    await expect(engine({}, { workspaceRoot: "project" })).rejects.toThrow(
      "workspaceRoot must be an absolute path",
    );
    await expect(engine({}, { homeDir: "home" })).rejects.toThrow(
      "homeDir must be an absolute path",
    );
  });
});

describe("approval", () => {
  it("raises a request that names the call, the reason, and grants that cover it", async () => {
    const { engine: policy } = await engine();

    const request = asked(
      policy.evaluate({
        ...CALLS.editInside,
        sessionId: "session-1",
        toolCallId: "call-1",
      }),
    );

    expect(request).toEqual({
      id: expect.stringMatching(/^approval-[0-9a-f-]{36}$/),
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "edit",
      args: { path: `${WORKSPACE}/src/a.ts` },
      capabilities: ["workspace_write"],
      target: { kind: "path", path: `${WORKSPACE}/src/a.ts` },
      reason: "Workspace writes need approval in ask mode",
      rule: "mode:ask",
      suggestions: [
        {
          rule: "edit(src/a.ts)",
          scope: "exact",
          description: expect.any(String),
        },
        { rule: "edit", scope: "tool", description: expect.any(String) },
        {
          rule: "capability:workspace_write",
          scope: "capability",
          description: expect.any(String),
        },
      ],
    });
  });

  it("offers the server for an MCP call and the exact command for a simple one", async () => {
    const { engine: policy } = await engine();

    expect(
      asked(policy.evaluate(CALLS.mcp)).suggestions.map((s) => s.rule),
    ).toEqual([
      "mcp__github__create_issue",
      "mcp__github",
      "capability:external",
    ]);
    expect(
      asked(policy.evaluate(CALLS.bash)).suggestions.map((s) => s.rule),
    ).toEqual(["bash(npm test)", "bash", "capability:process"]);
  });

  it("offers no exact-command grant for a compound command", async () => {
    const { engine: policy } = await engine();
    const compound = "npm test && git push";

    const request = asked(
      policy.evaluate({
        ...CALLS.bash,
        args: { command: compound },
        target: { kind: "command", command: compound },
      }),
    );

    // Only the exact command is withheld; a whole-tool grant still covers it.
    expect(request.suggestions.map((s) => s.rule)).toEqual([
      "bash",
      "capability:process",
    ]);
  });

  it("survives a JSON round trip, and the answer may come back as JSON", async () => {
    const { engine: policy } = await engine();
    const request = asked(policy.evaluate(CALLS.bash));

    const wire = JSON.stringify(request);
    expect(JSON.parse(wire)).toEqual(request);

    const answer = JSON.parse(
      JSON.stringify({
        requestId: JSON.parse(wire).id,
        decision: "allow_once",
      }),
    );
    await expect(policy.answer(answer)).resolves.toMatchObject({
      outcome: "allow",
      actor: "user",
      rule: "approval:allow_once",
    });
  });

  it("allows once without changing later decisions", async () => {
    const { engine: policy } = await engine();
    const request = asked(policy.evaluate(CALLS.bash));

    await policy.answer({ requestId: request.id, decision: "allow_once" });

    expect(policy.evaluate(CALLS.bash).outcome).toBe("ask");
    expect(policy.listSessionGrants()).toEqual([]);
  });

  it("returns the operator's reason on a denial", async () => {
    const { engine: policy } = await engine();
    const request = asked(policy.evaluate(CALLS.bash));

    await expect(
      policy.answer({
        requestId: request.id,
        decision: "deny",
        reason: "run the unit tests only",
      }),
    ).resolves.toEqual({
      outcome: "deny",
      rule: "approval:deny",
      reason: "run the unit tests only",
      actor: "user",
      source: "approval",
    });
    expect(policy.evaluate(CALLS.bash).outcome).toBe("ask");
  });

  it.each([
    ["this exact call", "bash(npm test)", ["bash"], ["mcp"]],
    ["the tool", "bash", ["bash"], ["mcp", "editInside"]],
    ["the capability", "capability:process", ["bash"], ["mcp"]],
  ] as const)(
    "a session grant for %s stops further prompts of that kind only",
    async (_label, rule, allowed, stillAsked) => {
      const { engine: policy, store } = await engine();
      const request = asked(policy.evaluate(CALLS.bash));

      const decision = await policy.answer({
        requestId: request.id,
        decision: "allow_session",
        rule,
      });

      expect(decision).toMatchObject({
        outcome: "allow",
        actor: "user",
        rule: `approval:allow_session:${rule}`,
      });
      for (const name of allowed) {
        expect(policy.evaluate(CALLS[name])).toMatchObject({
          outcome: "allow",
          rule: `session_grant:${rule}`,
          source: "session",
        });
      }
      for (const name of stillAsked) {
        expect(policy.evaluate(CALLS[name]).outcome).toBe("ask");
      }
      // Nothing was written, so a new session starts without the grant.
      expect(await store.load(OWNER)).toEqual({ allow: [], ask: [], deny: [] });
    },
  );

  it("grants every tool of an MCP server for the session", async () => {
    const { engine: policy } = await engine();
    const request = asked(policy.evaluate(CALLS.mcp));

    await policy.answer({
      requestId: request.id,
      decision: "allow_session",
      rule: "mcp__github",
    });

    expect(
      policy.evaluate({ ...CALLS.mcp, toolName: "mcp__github__list" }).outcome,
    ).toBe("allow");
    expect(
      policy.evaluate({
        ...CALLS.mcp,
        toolName: "mcp__jira__list",
        target: { kind: "mcp", serverPrefix: "mcp__jira" },
      }).outcome,
    ).toBe("ask");
  });

  it("carries session grants across a resume and not into a new session", async () => {
    const first = await engine();
    const request = asked(first.engine.evaluate(CALLS.bash));
    await first.engine.answer({
      requestId: request.id,
      decision: "allow_session",
      rule: "bash",
    });
    const saved = JSON.parse(JSON.stringify(first.engine.listSessionGrants()));

    const resumed = await PolicyEngine.create({
      store: first.store,
      owner: OWNER,
      workspaceRoot: WORKSPACE,
    });
    resumed.restoreSessionGrants(saved);
    const fresh = await PolicyEngine.create({
      store: first.store,
      owner: OWNER,
      workspaceRoot: WORKSPACE,
    });

    expect(resumed.evaluate(CALLS.bash).outcome).toBe("allow");
    expect(fresh.evaluate(CALLS.bash).outcome).toBe("ask");
  });

  it("lists and revokes session grants", async () => {
    const { engine: policy } = await engine();
    policy.addSessionGrant("bash");
    policy.addSessionGrant(" bash ");
    policy.addSessionGrant("edit(src/**)");

    expect(policy.listSessionGrants()).toEqual(["bash", "edit(src/**)"]);
    expect(policy.revokeSessionGrant("bash")).toBe(true);
    expect(policy.revokeSessionGrant("bash")).toBe(false);
    expect(policy.evaluate(CALLS.bash).outcome).toBe("ask");
    expect(policy.describe().rules).toEqual([
      { effect: "allow", rule: "edit(src/**)", source: "session" },
    ]);
  });

  it("persists an always-allow rule that a new engine then honors", async () => {
    const { engine: policy, store } = await engine({
      deny: ["bash(git push:*)"],
    });
    const request = asked(policy.evaluate(CALLS.bash));

    await expect(
      policy.answer({
        requestId: request.id,
        decision: "allow_always",
        rule: "bash(npm test)",
      }),
    ).resolves.toMatchObject({
      outcome: "allow",
      actor: "user",
      rule: "approval:allow_always:bash(npm test)",
    });

    expect(await store.load(OWNER)).toEqual({
      allow: ["bash(npm test)"],
      ask: [],
      deny: ["bash(git push:*)"],
    });
    const next = await PolicyEngine.create({
      store,
      owner: OWNER,
      workspaceRoot: WORKSPACE,
    });
    expect(next.evaluate(CALLS.bash)).toMatchObject({
      outcome: "allow",
      rule: "bash(npm test)",
      source: "user",
    });
  });

  it.each([
    ["a rule that does not cover the call", "edit(src/**)", "does not cover"],
    ["another tool", "write", "does not cover"],
    ["a rule that cannot be read", "bash(", "Invalid permission rule"],
  ])(
    "rejects a grant for %s and keeps the request open",
    async (_l, rule, message) => {
      const { engine: policy, store } = await engine();
      const request = asked(policy.evaluate(CALLS.bash));

      for (const decision of ["allow_session", "allow_always"] as const) {
        const attempt = policy.answer({
          requestId: request.id,
          decision,
          rule,
        });
        await expect(attempt).rejects.toThrow(ApprovalAnswerError);
        await expect(attempt).rejects.toThrow(message);
      }

      expect(policy.listSessionGrants()).toEqual([]);
      expect((await store.load(OWNER)).allow).toEqual([]);
      await expect(
        policy.answer({ requestId: request.id, decision: "allow_once" }),
      ).resolves.toMatchObject({ outcome: "allow" });
    },
  );

  it("rejects an answer to a request it did not raise, or raised and closed", async () => {
    const { engine: policy } = await engine();
    const other = await engine();
    const request = asked(policy.evaluate(CALLS.bash));

    await expect(
      other.engine.answer({ requestId: request.id, decision: "allow_once" }),
    ).rejects.toThrow(ApprovalAnswerError);
    await expect(
      policy.answer({ requestId: "approval-99", decision: "allow_once" }),
    ).rejects.toThrow("No pending approval request with id approval-99");

    await policy.answer({ requestId: request.id, decision: "deny" });
    await expect(
      policy.answer({ requestId: request.id, decision: "allow_once" }),
    ).rejects.toThrow(ApprovalAnswerError);
  });

  it("rejects an unknown decision and a malformed answer", async () => {
    const { engine: policy } = await engine();
    const request = asked(policy.evaluate(CALLS.bash));

    await expect(
      policy.answer({ requestId: request.id, decision: "yes" } as never),
    ).rejects.toThrow("Unknown approval decision yes");
    await expect(policy.answer(undefined as never)).rejects.toThrow(
      ApprovalAnswerError,
    );
  });

  it("forgets an abandoned request", async () => {
    const { engine: policy } = await engine();
    const request = asked(policy.evaluate(CALLS.bash));

    policy.abandon(request.id);

    await expect(
      policy.answer({ requestId: request.id, decision: "allow_once" }),
    ).rejects.toThrow(ApprovalAnswerError);
  });

  it("uses supplied request identifiers", async () => {
    const { engine: policy } = await engine(
      {},
      { createRequestId: () => "req-x" },
    );
    expect(asked(policy.evaluate(CALLS.bash)).id).toBe("req-x");
  });
});

describe("editing stored rules", () => {
  it("adds, moves, and removes rules through the store", async () => {
    const { engine: policy, store } = await engine({ preset: "accept-edits" });

    await policy.addRule("allow", " bash(npm test) ");
    await policy.addRule("deny", "bash(npm test)");
    await policy.addRule("ask", "edit(docs/**)");

    expect(await store.load(OWNER)).toEqual({
      preset: "accept-edits",
      allow: [],
      ask: ["edit(docs/**)"],
      deny: ["bash(npm test)"],
    });
    expect(policy.evaluate(CALLS.bash).outcome).toBe("deny");
    expect(await policy.removeRule("bash(npm test)")).toBe(true);
    expect(await policy.removeRule("bash(npm test)")).toBe(false);
    expect(policy.evaluate(CALLS.bash).outcome).toBe("ask");
  });

  it("does not save a rule that cannot be read", async () => {
    const { engine: policy, store } = await engine();

    await expect(policy.addRule("allow", "bash(")).rejects.toThrow(
      PolicyRuleError,
    );
    expect(await store.load(OWNER)).toEqual({ allow: [], ask: [], deny: [] });
  });

  it("keeps the rules in use when saving fails", async () => {
    const failing: PermissionStore = {
      load: async () => ({ allow: [], ask: [], deny: [] }),
      update: async () => {
        throw new Error("disk full");
      },
    };
    const policy = await PolicyEngine.create({
      store: failing,
      owner: OWNER,
      workspaceRoot: WORKSPACE,
    });
    const request = asked(policy.evaluate(CALLS.bash));

    await expect(policy.addRule("allow", "bash")).rejects.toThrow("disk full");
    await expect(
      policy.answer({
        requestId: request.id,
        decision: "allow_always",
        rule: "bash",
      }),
    ).rejects.toThrow("disk full");
    await expect(policy.setPreset("bypass", { persist: true })).rejects.toThrow(
      "disk full",
    );

    expect(policy.describe()).toEqual({
      preset: "ask",
      mode: "ask",
      rules: [],
    });
    expect(policy.evaluate(CALLS.bash).outcome).toBe("ask");
    // The failed always-allow reopened the request.
    await expect(
      policy.answer({ requestId: request.id, decision: "allow_once" }),
    ).resolves.toMatchObject({ outcome: "allow" });
  });

  it("switches preset for the instance, and stores it only when asked", async () => {
    const { engine: policy, store } = await engine({}, { mode: "bypass" });

    await policy.setPreset("read-only");
    expect(policy.describe()).toMatchObject({
      preset: "read-only",
      mode: "ask",
    });
    expect((await store.load(OWNER)).preset).toBeUndefined();

    await policy.setPreset("accept-edits", { persist: true });
    expect((await store.load(OWNER)).preset).toBe("accept-edits");
    await expect(policy.setPreset("yolo")).rejects.toThrow(
      'Unknown permission preset "yolo"',
    );

    policy.setMode("bypass");
    expect(policy.describe()).toMatchObject({
      preset: "accept-edits",
      mode: "bypass",
    });
  });
});

describe("owner scopes", () => {
  it("keeps two owners' rules, grants, and requests apart in one process", async () => {
    const store = new InMemoryPermissionStore({
      alice: { allow: ["bash"], ask: [], deny: [] },
      bob: { allow: [], ask: [], deny: ["bash"] },
    });
    const create = (owner: string) =>
      PolicyEngine.create({ store, owner, workspaceRoot: WORKSPACE });
    const [alice, bob, carol] = await Promise.all(
      ["alice", "bob", "carol"].map(create),
    );

    expect(alice.evaluate(CALLS.bash).outcome).toBe("allow");
    expect(bob.evaluate(CALLS.bash).outcome).toBe("deny");
    expect(carol.evaluate(CALLS.bash).outcome).toBe("ask");

    // A change by one owner reaches neither the other engines nor their store.
    await alice.addRule("deny", "edit");
    alice.addSessionGrant("mcp__github");
    await carol.addRule("allow", "edit");

    expect(alice.evaluate(CALLS.editInside).outcome).toBe("deny");
    expect(bob.evaluate(CALLS.editInside).outcome).toBe("ask");
    expect(bob.evaluate(CALLS.mcp).outcome).toBe("ask");
    expect(carol.evaluate(CALLS.editInside).outcome).toBe("allow");
    expect(await store.load("bob")).toEqual({
      allow: [],
      ask: [],
      deny: ["bash"],
    });
    expect((await create("bob")).describe().rules).toEqual([
      { effect: "deny", rule: "bash", source: "user" },
    ]);

    const request = asked(carol.evaluate(CALLS.bash));
    await expect(
      bob.answer({ requestId: request.id, decision: "allow_once" }),
    ).rejects.toThrow(ApprovalAnswerError);
  });

  it("does not let a caller change stored settings through a returned object", async () => {
    const store = new InMemoryPermissionStore();
    const initial = { allow: ["bash"], ask: [], deny: [] };
    await store.update("alice", () => initial);
    initial.allow.push("edit");
    const loaded = await store.load("alice");
    (loaded.allow as string[]).push("write");

    expect(await store.load("alice")).toEqual({
      allow: ["bash"],
      ask: [],
      deny: [],
    });
  });
});

/** Delays each update until released, applying it atomically on release. */
function gatedStore(inner: InMemoryPermissionStore) {
  const gates: Array<() => void> = [];
  const store: PermissionStore = {
    load: (owner) => inner.load(owner),
    update: async (owner, change: PermissionSettingsChange) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return inner.update(owner, change);
    },
  };
  const releaseAll = async () => {
    while (gates.length > 0) {
      gates.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const waitForGate = async () => {
    while (gates.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { store, releaseAll, waitForGate };
}

describe("answers checked against rules that changed while waiting", () => {
  it.each([
    ["allow_once", undefined],
    ["allow_session", "bash"],
    ["allow_always", "bash"],
  ] as const)(
    "%s is refused when this engine added a matching deny",
    async (decision, rule) => {
      const { engine: policy, store } = await engine();
      const request = asked(policy.evaluate(CALLS.bash));
      await policy.addRule("deny", "bash");

      const result = await policy.answer({
        requestId: request.id,
        decision,
        ...(rule ? { rule } : {}),
      } as never);

      expect(result).toMatchObject({
        outcome: "deny",
        rule: "bash",
        source: "user",
        actor: "application",
      });
      expect(policy.listSessionGrants()).toEqual([]);
      // Choosing the same text as the deny must not move it out of deny.
      expect(await store.load(OWNER)).toEqual({
        allow: [],
        ask: [],
        deny: ["bash"],
      });
      await expect(
        policy.answer({ requestId: request.id, decision: "allow_once" }),
      ).rejects.toThrow(ApprovalAnswerError);
    },
  );

  it.each(["allow_once", "allow_session", "allow_always"] as const)(
    "%s is refused when another engine for the owner added a deny",
    async (decision) => {
      const { engine: policy, store } = await engine();
      const other = await PolicyEngine.create({
        store,
        owner: OWNER,
        workspaceRoot: WORKSPACE,
      });
      const request = asked(policy.evaluate(CALLS.bash));
      await other.addRule("deny", "bash(npm:*)");

      const result = await policy.answer({
        requestId: request.id,
        decision,
        ...(decision === "allow_once" ? {} : { rule: "bash(npm test)" }),
      } as never);

      expect(result).toMatchObject({ outcome: "deny", rule: "bash(npm:*)" });
      expect(await store.load(OWNER)).toEqual({
        allow: [],
        ask: [],
        deny: ["bash(npm:*)"],
      });
    },
  );

  it("is refused when a preset deny now applies", async () => {
    const { engine: policy } = await engine();
    const request = asked(policy.evaluate(CALLS.bash));
    await policy.setPreset("read-only");

    await expect(
      policy.answer({ requestId: request.id, decision: "allow_once" }),
    ).resolves.toMatchObject({
      outcome: "deny",
      rule: "capability:process",
      source: "preset",
    });
  });

  it("removes an always-allowed rule from ask but leaves unrelated denies", async () => {
    const { engine: policy, store } = await engine({
      ask: ["bash"],
      deny: ["edit"],
    });
    const request = asked(policy.evaluate(CALLS.bash));

    await policy.answer({
      requestId: request.id,
      decision: "allow_always",
      rule: "bash",
    });

    expect(await store.load(OWNER)).toEqual({
      allow: ["bash"],
      ask: [],
      deny: ["edit"],
    });
    expect(policy.evaluate(CALLS.bash).outcome).toBe("allow");
  });
});

describe("concurrent answers and writes", () => {
  it("lets only the first answer decide while a permanent grant is saving", async () => {
    const inner = new InMemoryPermissionStore();
    const { store, releaseAll, waitForGate } = gatedStore(inner);
    const policy = await PolicyEngine.create({
      store,
      owner: OWNER,
      workspaceRoot: WORKSPACE,
    });
    const request = asked(policy.evaluate(CALLS.bash));

    const first = policy.answer({
      requestId: request.id,
      decision: "allow_always",
      rule: "bash",
    });
    await waitForGate();
    await expect(
      policy.answer({ requestId: request.id, decision: "deny" }),
    ).rejects.toThrow(ApprovalAnswerError);
    await releaseAll();

    await expect(first).resolves.toMatchObject({ outcome: "allow" });
    expect((await inner.load(OWNER)).allow).toEqual(["bash"]);
  });

  it("keeps every rule when one engine writes concurrently", async () => {
    const inner = new InMemoryPermissionStore();
    const { store, releaseAll, waitForGate } = gatedStore(inner);
    const policy = await PolicyEngine.create({
      store,
      owner: OWNER,
      workspaceRoot: WORKSPACE,
    });

    const writes = Promise.all([
      policy.addRule("deny", "bash(git push:*)"),
      policy.addRule("deny", "edit(secrets/**)"),
      policy.addRule("allow", "read"),
    ]);
    await waitForGate();
    await releaseAll();
    await writes;

    const stored = await inner.load(OWNER);
    expect([...stored.deny].sort()).toEqual([
      "bash(git push:*)",
      "edit(secrets/**)",
    ]);
    expect(stored.allow).toEqual(["read"]);
    expect(
      [...policy.describe().rules].map((rule) => rule.rule).sort(),
    ).toEqual(["bash(git push:*)", "edit(secrets/**)", "read"]);
  });

  it("keeps another engine's deny when an engine with stale settings writes", async () => {
    const store = new InMemoryPermissionStore();
    const create = () =>
      PolicyEngine.create({ store, owner: OWNER, workspaceRoot: WORKSPACE });
    const first = await create();
    const second = await create();

    await first.addRule("deny", "bash(git push:*)");
    await second.addRule("allow", "bash");
    await second.removeRule("edit");
    await second.setPreset("accept-edits", { persist: true });

    expect(await store.load(OWNER)).toEqual({
      preset: "accept-edits",
      allow: ["bash"],
      ask: [],
      deny: ["bash(git push:*)"],
    });
    // The writing engine now uses the stored rules, including the other deny.
    expect(
      second.evaluate({
        ...CALLS.bash,
        target: { kind: "command", command: "git push" },
      }).outcome,
    ).toBe("deny");
  });

  it("picks up another engine's rules on reload", async () => {
    const store = new InMemoryPermissionStore();
    const create = () =>
      PolicyEngine.create({ store, owner: OWNER, workspaceRoot: WORKSPACE });
    const first = await create();
    const second = await create();
    await first.addRule("deny", "bash");

    expect(second.evaluate(CALLS.bash).outcome).toBe("ask");
    await second.reload();
    expect(second.evaluate(CALLS.bash).outcome).toBe("deny");
  });
});

describe("exact path grants", () => {
  it.each([
    ["notes*.txt", ["notes-2.txt", "notes.txt"]],
    ["file?.md", ["file1.md"]],
    ["x[ab].ts", ["xa.ts"]],
    ["{a,b}.json", ["a.json", "b.json"]],
    ["p(1).txt", ["p1.txt"]],
    ["+(a|b)", ["a"]],
    ["!draft", ["draft", "other"]],
  ])("cover only the file literally named %s", async (name, others) => {
    const { engine: policy } = await engine();
    const target = `${WORKSPACE}/${name}`;
    const request = asked(policy.evaluate(fileCall("edit", WRITE, target)));
    const exact = request.suggestions.find((s) => s.scope === "exact");

    expect(exact?.description).toBe(`edit on ${name}`);
    await policy.answer({
      requestId: request.id,
      decision: "allow_session",
      rule: exact!.rule,
    });

    expect(policy.evaluate(fileCall("edit", WRITE, target)).outcome).toBe(
      "allow",
    );
    for (const other of others) {
      expect({
        other,
        outcome: policy.evaluate(
          fileCall("edit", WRITE, `${WORKSPACE}/${other}`),
        ).outcome,
      }).toEqual({ other, outcome: "ask" });
    }
  });

  it("use the absolute path for a workspace directory named ~", async () => {
    const { engine: policy } = await engine();
    const target = `${WORKSPACE}/~/notes.txt`;
    const request = asked(policy.evaluate(fileCall("edit", WRITE, target)));

    const exact = request.suggestions.find((s) => s.scope === "exact");
    expect(exact?.rule).toBe(`edit(${target})`);
    expect(exact?.description).toBe("edit on ~/notes.txt");
  });
});

describe("built-in presets", () => {
  it("cannot be changed through the objects callers receive", async () => {
    const listed = listPresets();
    const readOnly = getPreset("read-only")!;

    expect(() => (listed as PermissionPresetLike[]).push(readOnly)).toThrow(
      TypeError,
    );
    expect(() => {
      (readOnly as PermissionPresetLike).mode = "bypass";
    }).toThrow(TypeError);
    expect(() => (readOnly.deny as string[]).splice(0)).toThrow(TypeError);
    expect(() => (getPreset("ask")!.allow as string[]).push("bash")).toThrow(
      TypeError,
    );

    const fresh = await PolicyEngine.create({
      store: new InMemoryPermissionStore(),
      owner: "someone-else",
      workspaceRoot: WORKSPACE,
      preset: "read-only",
    });
    expect(fresh.mode).toBe("ask");
    expect(fresh.evaluate(CALLS.bash).outcome).toBe("deny");
    expect(listPresets()).toHaveLength(4);
  });
});

type PermissionPresetLike = { mode: string };
