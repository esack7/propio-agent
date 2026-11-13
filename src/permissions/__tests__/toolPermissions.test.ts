import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";
import {
  InMemoryPermissionStore,
  UNDECLARED_TOOL_METADATA,
  type ApprovalAnswer,
  type ApprovalRequest,
  type PermissionSettings,
  type ToolMetadata,
} from "../../policy/index.js";
import type { ApprovalChannel } from "../approvalChannel.js";
import {
  GLOBAL_INSTALL_ENV_RULE,
  LOCAL_PERMISSION_OWNER,
  NON_INTERACTIVE_RULE,
  ToolPermissions,
  type ToolAuthorizationInput,
  type ToolPermissionsOptions,
} from "../toolPermissions.js";

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

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "perm-")));
  workspace = path.join(root, "workspace");
  outside = path.join(root, "outside");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(workspace, "src/a.ts"), "a");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

type Reply =
  | ApprovalAnswer["decision"]
  | ((request: ApprovalRequest) => ApprovalAnswer | Promise<ApprovalAnswer>);

/** A channel that records what it was asked and answers from a script. */
function scriptedChannel(reply: Reply = "allow_once"): ApprovalChannel & {
  requests: ApprovalRequest[];
} {
  const requests: ApprovalRequest[] = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      if (typeof reply === "function") return await reply(request);
      if (reply === "allow_once" || reply === "deny") {
        return { requestId: request.id, decision: reply };
      }
      return {
        requestId: request.id,
        decision: reply,
        rule: request.suggestions.find((s) => s.scope === "tool")!.rule,
      };
    },
  };
}

function permissions(
  options: ToolPermissionsOptions = {},
  settings?: Partial<PermissionSettings>,
): ToolPermissions {
  return new ToolPermissions({
    workspaceRoot: workspace,
    homeDir: root,
    ...(settings
      ? {
          store: new InMemoryPermissionStore({
            [LOCAL_PERMISSION_OWNER]: {
              allow: [],
              ask: [],
              deny: [],
              ...settings,
            },
          }),
        }
      : {}),
    ...options,
  });
}

const call = {
  read: (target = "src/a.ts"): ToolAuthorizationInput => ({
    name: "read",
    args: { path: target },
    metadata: READ,
  }),
  grep: (): ToolAuthorizationInput => ({
    name: "grep",
    args: { path: "src", pattern: "a" },
    metadata: READ,
  }),
  find: (): ToolAuthorizationInput => ({
    name: "find",
    args: { path: ".", pattern: "*.ts" },
    metadata: READ,
  }),
  ls: (): ToolAuthorizationInput => ({
    name: "ls",
    args: { path: "." },
    metadata: READ,
  }),
  write: (target = "src/a.ts"): ToolAuthorizationInput => ({
    name: "write",
    args: { path: target, content: "x" },
    metadata: WRITE,
  }),
  edit: (): ToolAuthorizationInput => ({
    name: "edit",
    args: { path: "src/a.ts", old_text: "a", new_text: "b" },
    metadata: WRITE,
  }),
  bash: (
    command = "npm test",
    extra: Record<string, unknown> = {},
  ): ToolAuthorizationInput => ({
    name: "bash",
    args: { command, ...extra },
    metadata: PROCESS,
  }),
  mcp: (): ToolAuthorizationInput => ({
    name: "mcp__github__create_issue",
    args: { title: "x" },
    metadata: UNDECLARED_TOOL_METADATA,
    mcpServerName: "github",
  }),
};

describe("the default", () => {
  it("is ask mode when nothing is configured (a6)", async () => {
    const policy = new ToolPermissions({ workspaceRoot: workspace });

    await policy.refresh();

    expect(policy.describe()).toEqual({ preset: "ask", mode: "ask" });
  });
});

describe("ask mode (a2)", () => {
  it.each(["write", "edit", "bash", "mcp"] as const)(
    "%s is put to the operator before it may run",
    async (name) => {
      const channel = scriptedChannel("allow_once");
      const policy = permissions({ approvalChannel: channel });

      const decision = await policy.authorize(call[name]());

      expect(channel.requests).toHaveLength(1);
      expect(channel.requests[0]).toMatchObject({
        toolName: call[name]().name,
      });
      expect(decision).toMatchObject({
        allowed: true,
        actor: "user",
        rule: "approval:allow_once",
      });
    },
  );

  it.each(["write", "edit", "bash", "mcp"] as const)(
    "%s does not run when the operator says no",
    async (name) => {
      const policy = permissions({ approvalChannel: scriptedChannel("deny") });

      expect(await policy.authorize(call[name]())).toMatchObject({
        allowed: false,
        actor: "user",
        rule: "approval:deny",
      });
    },
  );

  it.each(["read", "grep", "find", "ls"] as const)(
    "%s inside the workspace runs without a prompt",
    async (name) => {
      const channel = scriptedChannel("deny");
      const policy = permissions({ approvalChannel: channel });

      const decision = await policy.authorize(call[name]());

      expect(channel.requests).toHaveLength(0);
      expect(decision).toMatchObject({
        allowed: true,
        actor: "application",
        rule: "mode:ask",
      });
    },
  );

  it("returns the operator's reason for the model", async () => {
    const policy = permissions({
      approvalChannel: scriptedChannel((request) => ({
        requestId: request.id,
        decision: "deny",
        reason: "use the staging database instead",
      })),
    });

    expect((await policy.authorize(call.bash())).reason).toBe(
      "Permission denied for bash: use the staging database instead",
    );
  });
});

describe("workspace confinement", () => {
  it("asks before reading outside the workspace", async () => {
    const channel = scriptedChannel("deny");
    const policy = permissions({ approvalChannel: channel });

    await policy.authorize(call.read(path.join(outside, "secret.txt")));
    await policy.authorize(call.read("../outside/secret.txt"));

    expect(channel.requests.map((request) => request.reason)).toEqual([
      "The path is outside the workspace",
      "The path is outside the workspace",
    ]);
  });

  it("asks before reading through a link that leaves the workspace", async () => {
    fs.symlinkSync(outside, path.join(workspace, "link"));
    const channel = scriptedChannel("deny");
    const policy = permissions({ approvalChannel: channel });

    const decision = await policy.authorize(call.read("link/secret.txt"));

    expect(decision.allowed).toBe(false);
    expect(channel.requests[0]?.target).toEqual({
      kind: "path",
      path: path.join(outside, "secret.txt"),
    });
  });

  it("asks about a write outside the workspace even in accept-edits", async () => {
    const channel = scriptedChannel("deny");
    const policy = permissions({
      approvalChannel: channel,
      preset: "accept-edits",
    });

    expect((await policy.authorize(call.write())).allowed).toBe(true);
    expect(channel.requests).toHaveLength(0);
    await policy.authorize(call.write(path.join(outside, "new.txt")));
    expect(channel.requests).toHaveLength(1);
  });

  it("refuses a path it cannot resolve", async () => {
    fs.symlinkSync(
      path.join(outside, "missing"),
      path.join(workspace, "dangling"),
    );
    const policy = permissions({
      approvalChannel: scriptedChannel("allow_once"),
      preset: "bypass",
    });

    await expect(policy.authorize(call.write("dangling"))).rejects.toThrow(
      /symbolic link to a missing path/,
    );
  });
});

describe("without an approval channel (a8)", () => {
  it("denies at once instead of waiting for an answer", async () => {
    const policy = permissions();

    const decision = await policy.authorize(call.bash());

    expect(decision).toMatchObject({
      allowed: false,
      actor: "application",
      rule: NON_INTERACTIVE_RULE,
    });
    expect(decision.reason).toContain("not available in non-interactive mode");
    expect(decision.reason).toContain("--permissions");
  });

  it("still runs what needs no approval, and what a rule allows", async () => {
    const policy = permissions({}, { allow: ["bash(npm test)"] });

    expect((await policy.authorize(call.read())).allowed).toBe(true);
    expect(await policy.authorize(call.bash())).toMatchObject({
      allowed: true,
      rule: "bash(npm test)",
    });
  });

  it("leaves no request waiting, so a later answer cannot approve the call", async () => {
    const policy = permissions();
    await policy.authorize(call.bash());
    const channel = scriptedChannel((request) => ({
      requestId: request.id,
      decision: "allow_once",
    }));
    policy.setApprovalChannel(channel);

    await policy.authorize(call.bash());

    // Each ask raised its own request; the first was dropped, not reused.
    expect(channel.requests).toHaveLength(1);
  });
});

describe("a channel that does not answer cleanly", () => {
  it("fails closed when the channel throws", async () => {
    const policy = permissions({
      approvalChannel: {
        request: async () => {
          throw new Error("terminal went away");
        },
      },
    });

    await expect(policy.authorize(call.bash())).rejects.toThrow(
      "terminal went away",
    );
  });

  it("rejects an answer for a different request", async () => {
    const policy = permissions({
      approvalChannel: {
        request: async () => ({
          requestId: "approval-someone-else",
          decision: "allow_once",
        }),
      },
    });

    await expect(policy.authorize(call.bash())).rejects.toThrow(
      /Approval answer is for request approval-someone-else/,
    );
  });

  it("rejects a grant that does not cover the call, and the request cannot be answered again", async () => {
    let asked: ApprovalRequest | undefined;
    const policy = permissions({
      approvalChannel: {
        request: async (request) => {
          asked = request;
          return {
            requestId: request.id,
            decision: "allow_session",
            rule: "read",
          };
        },
      },
    });

    await expect(policy.authorize(call.bash())).rejects.toThrow(
      /does not cover the call/,
    );
    expect(policy.listSessionGrants()).toEqual([]);
    // The request was dropped: a second answer with the same id is unknown.
    policy.setApprovalChannel({
      request: async () => ({ requestId: asked!.id, decision: "allow_once" }),
    });
    await expect(policy.authorize(call.bash())).rejects.toThrow(
      /Approval answer is for request/,
    );
  });

  it("does not run the call when the turn is cancelled while the question is open", async () => {
    const controller = new AbortController();
    const policy = permissions({
      approvalChannel: {
        request: async (request) => {
          controller.abort(new Error("cancelled"));
          return {
            requestId: request.id,
            decision: "allow_session",
            rule: "bash",
          };
        },
      },
    });

    await expect(
      policy.authorize({ ...call.bash(), signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(policy.listSessionGrants()).toEqual([]);
  });

  it("passes the turn's signal to the channel", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const policy = permissions({
      approvalChannel: {
        request: async (request, signal) => {
          received = signal;
          return { requestId: request.id, decision: "deny" };
        },
      },
    });

    await policy.authorize({ ...call.bash(), signal: controller.signal });

    expect(received).toBe(controller.signal);
  });
});

describe("session grants (a5)", () => {
  it("stops further prompts of that kind for the session", async () => {
    const channel = scriptedChannel("allow_session");
    const policy = permissions({ approvalChannel: channel });

    const first = await policy.authorize(call.bash("npm test"));
    const second = await policy.authorize(call.bash("git status"));

    expect(first).toMatchObject({
      allowed: true,
      actor: "user",
      rule: "approval:allow_session:bash",
    });
    expect(second).toMatchObject({
      allowed: true,
      actor: "application",
      rule: "session_grant:bash",
    });
    expect(channel.requests).toHaveLength(1);
    expect(policy.listSessionGrants()).toEqual(["bash"]);
    // The grant is for one kind of call only.
    await policy.authorize(call.write());
    expect(channel.requests).toHaveLength(2);
  });

  it("is restored on resume and absent from a new session", async () => {
    const original = permissions({
      approvalChannel: scriptedChannel("allow_session"),
    });
    await original.authorize(call.bash());
    const saved = JSON.parse(JSON.stringify(original.listSessionGrants()));

    const resumedChannel = scriptedChannel("deny");
    const resumed = permissions({ approvalChannel: resumedChannel });
    resumed.restoreSessionGrants(saved);
    const freshChannel = scriptedChannel("deny");
    const fresh = permissions({ approvalChannel: freshChannel });

    expect((await resumed.authorize(call.bash())).allowed).toBe(true);
    expect(resumedChannel.requests).toHaveLength(0);
    expect((await fresh.authorize(call.bash())).allowed).toBe(false);
    expect(freshChannel.requests).toHaveLength(1);
  });

  it("applies grants restored before or after the rules have loaded", async () => {
    const before = permissions();
    before.restoreSessionGrants(["bash"]);
    expect(before.listSessionGrants()).toEqual(["bash"]);
    expect((await before.authorize(call.bash())).allowed).toBe(true);

    const after = permissions();
    await after.refresh();
    after.restoreSessionGrants(["bash"]);
    expect((await after.authorize(call.bash())).allowed).toBe(true);
    // Restoring replaces: resuming a session without grants clears them.
    after.restoreSessionGrants([]);
    expect((await after.authorize(call.bash())).allowed).toBe(false);
  });

  it("refuses to restore a grant it cannot read, changing nothing", async () => {
    const policy = permissions();
    policy.restoreSessionGrants(["bash"]);

    expect(() => policy.restoreSessionGrants(["read", "bash("])).toThrow(
      /Invalid permission rule/,
    );
    expect(policy.listSessionGrants()).toEqual(["bash"]);
  });

  it("never overrides a deny rule", async () => {
    const policy = permissions({}, { deny: ["bash(git push:*)"] });
    policy.restoreSessionGrants(["bash"]);

    expect(await policy.authorize(call.bash("git push origin"))).toMatchObject({
      allowed: false,
      rule: "bash(git push:*)",
      actor: "application",
    });
  });
});

describe("commands that do not run where the rule was approved", () => {
  it.each([
    ["a working directory outside the workspace", () => ({ cwd: outside })],
    ["environment overrides", () => ({ env: { NODE_ENV: "production" } })],
  ])("asks about an exactly-allowed command with %s", async (_label, extra) => {
    const channel = scriptedChannel("deny");
    const policy = permissions(
      { approvalChannel: channel },
      { allow: ["bash(npm test)", "bash(git status:*)"] },
    );

    expect((await policy.authorize(call.bash("npm test"))).allowed).toBe(true);
    expect(
      (await policy.authorize(call.bash("npm test", { cwd: "src" }))).allowed,
    ).toBe(true);
    expect(channel.requests).toHaveLength(0);

    await policy.authorize(call.bash("npm test", extra()));
    await policy.authorize(call.bash("git status -sb", extra()));

    expect(channel.requests).toHaveLength(2);
    // No exact grant is offered for such a call.
    expect(channel.requests[0]?.suggestions.map((s) => s.rule)).toEqual([
      "bash",
      "capability:process",
    ]);
  });

  it("still lets a whole-tool rule cover it, and a deny rule refuse it", async () => {
    const allowed = permissions({}, { allow: ["bash"] });
    const refused = permissions(
      {},
      { allow: ["bash"], deny: ["bash(npm test)"] },
    );

    expect(
      (await allowed.authorize(call.bash("npm test", { cwd: outside })))
        .allowed,
    ).toBe(true);
    expect(
      (await refused.authorize(call.bash("npm test", { cwd: outside })))
        .allowed,
    ).toBe(false);
  });
});

describe("global installs", () => {
  const install = "npm install -g eslint";

  it("asks with the classifier's reason", async () => {
    const channel = scriptedChannel("deny");
    const policy = permissions({ approvalChannel: channel });

    await policy.authorize(call.bash(install));
    await policy.authorize(call.bash("npm test"));

    expect(channel.requests[0]?.reason).toMatch(/global/i);
    expect(channel.requests[1]?.reason).toBe(
      "Calls with the process capability need approval in ask mode",
    );
  });

  it("is denied without a channel, as any other command that asks", async () => {
    expect(await permissions().authorize(call.bash(install))).toMatchObject({
      allowed: false,
      rule: NON_INTERACTIVE_RULE,
    });
  });

  it("runs unasked under an allow rule or in bypass", async () => {
    const byRule = permissions({}, { allow: [`bash(${install})`] });
    const bypass = permissions({ preset: "bypass" });

    expect((await byRule.authorize(call.bash(install))).allowed).toBe(true);
    expect(await bypass.authorize(call.bash(install))).toMatchObject({
      allowed: true,
      rule: "mode:bypass",
    });
  });

  it("runs unasked under the deprecated environment setting, for installs only", async () => {
    const channel = scriptedChannel("deny");
    const policy = permissions({
      approvalChannel: channel,
      allowGlobalInstallsWithoutPrompt: true,
    });

    expect(await policy.authorize(call.bash(install))).toMatchObject({
      allowed: true,
      actor: "application",
      rule: GLOBAL_INSTALL_ENV_RULE,
    });
    expect(channel.requests).toHaveLength(0);
    expect((await policy.authorize(call.bash("npm test"))).allowed).toBe(false);
  });

  it("does not let the deprecated setting override a deny or ask rule", async () => {
    const channel = scriptedChannel("deny");
    const denied = permissions(
      { allowGlobalInstallsWithoutPrompt: true },
      { deny: ["bash(npm install:*)"] },
    );
    const asking = permissions(
      { allowGlobalInstallsWithoutPrompt: true, approvalChannel: channel },
      { ask: ["bash(npm install:*)"] },
    );

    expect(await denied.authorize(call.bash(install))).toMatchObject({
      allowed: false,
      rule: "bash(npm install:*)",
    });
    expect((await asking.authorize(call.bash(install))).allowed).toBe(false);
    expect(channel.requests).toHaveLength(1);
  });
});

describe("calls the agent's plan or discover checks approved", () => {
  const approved = (input: ToolAuthorizationInput): ToolAuthorizationInput => ({
    ...input,
    agentModeApproval: "plan",
  });

  it("run without a prompt", async () => {
    const channel = scriptedChannel("deny");
    const policy = permissions({ approvalChannel: channel });

    expect(
      await policy.authorize(approved(call.bash("git log"))),
    ).toMatchObject({
      allowed: true,
      actor: "application",
      rule: "agent_mode:plan",
    });
    expect((await policy.authorize(approved(call.write()))).rule).toBe(
      "agent_mode:plan",
    );
    expect(channel.requests).toHaveLength(0);
  });

  it("still obey explicit ask and deny rules", async () => {
    const channel = scriptedChannel("deny");
    const policy = permissions(
      { approvalChannel: channel },
      { ask: ["bash(git log:*)"], deny: ["write(src/**)"] },
    );

    expect(
      (await policy.authorize(approved(call.bash("git log")))).allowed,
    ).toBe(false);
    expect(channel.requests).toHaveLength(1);
    expect(await policy.authorize(approved(call.write()))).toMatchObject({
      allowed: false,
      rule: "write(src/**)",
    });
  });
});

describe("decisions name who decided and by what rule (a9)", () => {
  it.each([
    ["a mode default", {}, {}, call.read(), "application", "mode:ask"],
    [
      "a stored rule",
      {},
      { allow: ["bash(npm test)"] },
      call.bash(),
      "application",
      "bash(npm test)",
    ],
    [
      "a deny rule",
      {},
      { deny: ["capability:process"] },
      call.bash(),
      "application",
      "capability:process",
    ],
    ["no channel", {}, {}, call.bash(), "application", NON_INTERACTIVE_RULE],
    [
      "bypass",
      { preset: "bypass" },
      {},
      call.bash(),
      "application",
      "mode:bypass",
    ],
  ] as const)("%s", async (_label, options, settings, input, actor, rule) => {
    const decision = await permissions(options, settings).authorize(input);

    expect(decision).toMatchObject({ actor, rule });
    expect(decision.reason).toEqual(expect.any(String));
  });
});

describe("stored rules", () => {
  it("are read again on refresh", async () => {
    const store = new InMemoryPermissionStore();
    const policy = permissions({ store });
    expect((await policy.authorize(call.bash())).allowed).toBe(false);

    await store.update(LOCAL_PERMISSION_OWNER, (current) => ({
      ...current,
      allow: ["bash(npm test)"],
    }));
    expect((await policy.authorize(call.bash())).allowed).toBe(false);
    await policy.refresh();

    expect((await policy.authorize(call.bash())).allowed).toBe(true);
  });

  it("fail the call while unreadable, and work once corrected", async () => {
    const store = new InMemoryPermissionStore({
      [LOCAL_PERMISSION_OWNER]: { allow: ["bash("], ask: [], deny: [] },
    });
    const policy = permissions({ store });

    await expect(policy.authorize(call.read())).rejects.toThrow(
      /Invalid permission rule/,
    );
    await store.update(LOCAL_PERMISSION_OWNER, (current) => ({
      ...current,
      allow: [],
    }));

    expect((await policy.authorize(call.read())).allowed).toBe(true);
  });
});

describe("an approval answered by another process (a11)", () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const fixture = fileURLToPath(
    new URL("./fixtures/approvalChild.mjs", import.meta.url),
  );

  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
  });

  /** Requests cross to the child as JSON text; answers come back the same way. */
  function childChannel(decision: string): ApprovalChannel & {
    wire: string[];
    pid: number | undefined;
  } {
    const child = spawn(process.execPath, [fixture, decision]);
    children.push(child);
    const lines = readline.createInterface({ input: child.stdout });
    const wire: string[] = [];
    return {
      wire,
      pid: child.pid,
      request: (request) =>
        new Promise<ApprovalAnswer>((resolve, reject) => {
          child.once("error", reject);
          lines.once("line", (line) => resolve(JSON.parse(line)));
          const text = JSON.stringify(request);
          wire.push(text);
          child.stdin.write(`${text}\n`);
        }),
    };
  }

  it("survives the JSON round trip and is allowed by the other process", async () => {
    const channel = childChannel("allow_session");
    const policy = permissions({ approvalChannel: channel });
    const input = { ...call.bash(), sessionId: "session-1", toolCallId: "c1" };

    const decision = await policy.authorize(input);

    expect(channel.pid).not.toBe(process.pid);
    expect(JSON.parse(channel.wire[0]!)).toMatchObject({
      id: expect.stringMatching(/^approval-/),
      sessionId: "session-1",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "npm test" },
      capabilities: ["process"],
      target: { kind: "command", command: "npm test" },
      suggestions: expect.arrayContaining([
        expect.objectContaining({ rule: "bash", scope: "tool" }),
      ]),
    });
    expect(decision).toMatchObject({
      allowed: true,
      actor: "user",
      rule: "approval:allow_session:bash",
    });
    expect(policy.listSessionGrants()).toEqual(["bash"]);
  });

  it("is denied by the other process, with its reason", async () => {
    const channel = childChannel("deny");
    const policy = permissions({ approvalChannel: channel });

    const decision = await policy.authorize(call.write());

    expect(decision).toMatchObject({ allowed: false, actor: "user" });
    expect(decision.reason).toBe(
      `Permission denied for write: child ${channel.pid} refused write`,
    );
  });
});
