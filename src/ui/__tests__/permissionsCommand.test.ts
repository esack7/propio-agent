import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LOCAL_PERMISSION_OWNER,
  ToolPermissions,
} from "../../permissions/toolPermissions.js";
import { InMemoryPermissionStore } from "../../policy/index.js";
import { handlePermissionsCommand } from "../permissionsCommand.js";

function fakeUi() {
  const lines: string[] = [];
  const record = (kind: string) => (text: string) => {
    lines.push(kind === "command" ? text : `[${kind}] ${text}`);
  };
  return {
    lines,
    command: record("command"),
    error: record("error"),
    info: record("info"),
    section: record("section"),
    success: record("success"),
  };
}

const PROCESS = {
  capabilities: ["process"],
  readOnly: false,
  concurrencySafe: false,
} as const;

describe("/permissions", () => {
  let workspace: string;
  let store: InMemoryPermissionStore;
  let permissions: ToolPermissions;
  let changes: number;

  beforeEach(() => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "propio-permcmd-")),
    );
    store = new InMemoryPermissionStore({
      [LOCAL_PERMISSION_OWNER]: {
        allow: ["bash(npm test)"],
        ask: [],
        deny: ["bash(git push:*)"],
      },
    });
    changes = 0;
    permissions = new ToolPermissions({
      store,
      workspaceRoot: workspace,
      homeDir: workspace,
      onChange: () => {
        changes += 1;
      },
    });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function run(input: string): Promise<string[]> {
    const ui = fakeUi();
    await handlePermissionsCommand(input, permissions, ui);
    return ui.lines;
  }

  const stored = () => store.load(LOCAL_PERMISSION_OWNER);

  it("shows the preset, mode, rules by source, grants, and that nothing was decided yet", async () => {
    permissions.restoreSessionGrants(["write"]);

    expect(await run("/permissions")).toEqual([
      "[section] Permissions",
      "  preset: ask    mode: ask",
      "[section] Rules",
      "  deny  bash(git push:*)  (settings)",
      "  allow bash(npm test)  (settings)",
      "[section] Session grants",
      "  allow write",
      "[section] Last decision",
      "  (no tool call has been decided yet)",
      "",
    ]);
  });

  it("shows preset rules with their source, and the last decision with its rule and actor", async () => {
    await permissions.setPreset("read-only");
    await permissions.authorize({
      name: "bash",
      args: { command: "git push origin" },
      metadata: PROCESS,
    });

    const lines = await run("/permissions");

    expect(lines).toContain("  preset: read-only    mode: ask");
    expect(lines).toContain("  deny  capability:process  (preset)");
    expect(lines).toContain(
      "  bash denied by capability:process (application)",
    );
  });

  it("says so when there are no rules or grants", async () => {
    await run("/permissions remove bash(npm test)");
    await run("/permissions remove bash(git push:*)");

    const lines = await run("/permissions");

    expect(lines).toContain("  (no rules)");
    expect(lines).toContain("  (none)");
  });

  it.each(["allow", "ask", "deny"] as const)(
    "saves an %s rule, moving it out of the other lists",
    async (effect) => {
      const lines = await run(`/permissions ${effect} bash(npm test)`);

      expect(lines).toEqual([
        `[success] Saved ${effect} rule bash(npm test).`,
        "",
      ]);
      const settings = await stored();
      expect(settings[effect]).toContain("bash(npm test)");
      expect(
        [...settings.allow, ...settings.ask, ...settings.deny].filter(
          (rule) => rule === "bash(npm test)",
        ),
      ).toHaveLength(1);
      expect(changes).toBe(1);
    },
  );

  it("keeps spaces inside a rule", async () => {
    await run("/permissions deny   bash(rm -rf  build:*)  ");

    expect((await stored()).deny).toContain("bash(rm -rf  build:*)");
  });

  it("removes a saved rule, and says when there is none", async () => {
    expect(await run("/permissions remove bash(git push:*)")).toEqual([
      "[success] Removed rule bash(git push:*).",
      "",
    ]);
    expect((await stored()).deny).toEqual([]);
    expect(await run("/permissions remove bash(git push:*)")).toEqual([
      "[error] No stored rule bash(git push:*).",
      "",
    ]);
    expect(changes).toBe(1);
  });

  it("revokes a session grant, and says when there is none", async () => {
    permissions.restoreSessionGrants(["write", "bash"]);

    expect(await run("/permissions revoke write")).toEqual([
      "[success] Revoked session grant write.",
      "",
    ]);
    expect(permissions.listSessionGrants()).toEqual(["bash"]);
    expect(await run("/permissions revoke write")).toEqual([
      "[error] No session grant write.",
      "",
    ]);
  });

  it("uses a preset for the session without storing it", async () => {
    expect(await run("/permissions preset bypass")).toEqual([
      "[success] Using the bypass preset for this session.",
      "",
    ]);

    expect(permissions.describe()).toEqual({
      preset: "bypass",
      mode: "bypass",
    });
    expect(await stored()).not.toHaveProperty("preset");
  });

  it("sets the mode for the session", async () => {
    await run("/permissions mode accept-edits");

    expect(permissions.describe()).toEqual({
      preset: "ask",
      mode: "accept-edits",
    });
  });

  it.each([
    [
      "an unreadable rule",
      "/permissions allow bash(",
      /Invalid permission rule/,
    ],
    [
      "an unknown preset",
      "/permissions preset everything",
      /Unknown permission preset/,
    ],
  ])("reports %s and changes nothing", async (_label, input, message) => {
    const before = await stored();

    const lines = await run(input);

    expect(lines[0]).toMatch(message);
    expect(lines[0]).toMatch(/^\[error\]/);
    expect(await stored()).toEqual(before);
    expect(changes).toBe(0);
  });

  it.each([
    "/permissions allow",
    "/permissions mode everything",
    "/permissions frobnicate bash",
    "/permissions preset",
  ])("shows usage for %j", async (input) => {
    const lines = await run(input);

    expect(lines[0]).toMatch(/^\[error\] Unknown \/permissions usage/);
    expect(lines).toContain("Usage: /permissions");
    expect(lines.join("\n")).toContain(
      "/permissions preset <read-only | ask | accept-edits | bypass>",
    );
    expect(changes).toBe(0);
  });

  it("shows rule text from the settings file with control characters escaped", async () => {
    await store.update(LOCAL_PERMISSION_OWNER, (current) => ({
      ...current,
      deny: ["bash(echo \x1b[2Khidden)"],
    }));
    await permissions.refresh();

    expect(await run("/permissions")).toContain(
      "  deny  bash(echo \\x1b[2Khidden)  (settings)",
    );
  });
});
