import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PolicyEngine } from "../../policy/index.js";
import { withFileLock } from "../fileLock.js";
import {
  FilePermissionStore,
  PermissionSettingsError,
  resolveSettingsLocation,
} from "../permissionStore.js";

const OWNER = "local";
const childScript = fileURLToPath(
  new URL("./fixtures/permissionStoreChild.mjs", import.meta.url),
);

let directory: string;
let filePath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "propio-permissions-"));
  filePath = path.join(directory, "nested", "settings.json");
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeSettings(value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const store = () => new FilePermissionStore({ filePath, owner: OWNER });

describe("loading", () => {
  it("has no rules when the file or its permissions object is missing", async () => {
    await expect(store().load(OWNER)).resolves.toEqual({
      allow: [],
      ask: [],
      deny: [],
    });
    writeSettings({ runtime: { maxIterations: 5 } });
    await expect(store().load(OWNER)).resolves.toEqual({
      allow: [],
      ask: [],
      deny: [],
    });
  });

  it("reads the preset and the three lists, filling in lists left out", async () => {
    writeSettings({
      permissions: { preset: "accept-edits", deny: ["bash(git push:*)"] },
    });

    await expect(store().load(OWNER)).resolves.toEqual({
      preset: "accept-edits",
      allow: [],
      ask: [],
      deny: ["bash(git push:*)"],
    });
  });

  it.each([
    ["JSON that does not parse", "{ not json", /not valid JSON/],
    ["a file that is not an object", "[1, 2]", /must contain a JSON object/],
    [
      "a list that is not a list",
      { permissions: { deny: "bash" } },
      /permissions\.deny/,
    ],
    [
      "a rule that is not a string",
      { permissions: { allow: [1] } },
      /permissions\.allow\.0/,
    ],
    ["a misspelled key", { permissions: { denny: [] } }, /permissions/],
    [
      "a preset that is not a string",
      { permissions: { preset: 3 } },
      /permissions\.preset/,
    ],
    ["permissions that is not an object", { permissions: [] }, /permissions/],
    // An explicit null is not an absent key: reading it as "no rules" would
    // start with no deny rules.
    ["permissions that is null", { permissions: null }, /permissions: /],
    ["permissions that is a string", { permissions: "ask" }, /permissions: /],
  ])("fails on %s, naming the file", async (_label, content, detail) => {
    writeSettings(content);

    const failure = await store()
      .load(OWNER)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PermissionSettingsError);
    expect((failure as Error).message).toContain(filePath);
    expect((failure as Error).message).toMatch(detail);
  });

  it.each([
    [
      "a rule that cannot be read",
      { permissions: { deny: ["bash", "bash("] } },
      /permissions\.deny\.1: Invalid permission rule "bash\("/,
    ],
    [
      "an unknown capability",
      { permissions: { allow: ["capability:everything"] } },
      /permissions\.allow\.0: .*unknown capability/,
    ],
    [
      "an unknown preset",
      { permissions: { preset: "everything" } },
      /permissions\.preset: unknown preset "everything"/,
    ],
  ])(
    "fails on %s, naming the file and field",
    async (_label, content, detail) => {
      writeSettings(content);

      const failure = await store()
        .load(OWNER)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PermissionSettingsError);
      expect((failure as Error).message).toContain(filePath);
      expect((failure as Error).message).toMatch(detail);
      await expect(
        PolicyEngine.create({
          store: store(),
          owner: OWNER,
          workspaceRoot: "/w",
        }),
      ).rejects.toThrow(PermissionSettingsError);
    },
  );

  it("does not store a rule or preset that cannot be read", async () => {
    writeSettings({ permissions: { deny: ["bash"] } });
    const before = fs.readFileSync(filePath, "utf8");

    await expect(
      store().update(OWNER, (current) => ({ ...current, allow: ["bash("] })),
    ).rejects.toThrow(/permissions\.allow\.0/);
    await expect(
      store().update(OWNER, (current) => ({ ...current, preset: "nope" })),
    ).rejects.toThrow(/permissions\.preset/);

    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("serves only the owner it was created for", async () => {
    await expect(store().load("someone-else")).rejects.toThrow(
      /not "someone-else"/,
    );
    await expect(
      store().update("someone-else", (current) => current),
    ).rejects.toThrow(/not "someone-else"/);
  });
});

describe("updating", () => {
  it("creates the file and its directory", async () => {
    const stored = await store().update(OWNER, (current) => ({
      ...current,
      allow: ["bash(npm test)"],
    }));

    expect(stored).toEqual({ allow: ["bash(npm test)"], ask: [], deny: [] });
    expect(readSettings()).toEqual({
      permissions: { allow: ["bash(npm test)"], ask: [], deny: [] },
    });
  });

  it("leaves every other key in the file as it was", async () => {
    writeSettings({
      runtime: { maxIterations: 7 },
      somethingElse: [1, { a: true }],
      permissions: { preset: "ask", deny: ["read(~/.ssh/**)"] },
    });

    await store().update(OWNER, (current) => ({
      ...current,
      allow: [...current.allow, "edit(src/**)"],
    }));

    expect(readSettings()).toEqual({
      runtime: { maxIterations: 7 },
      somethingElse: [1, { a: true }],
      permissions: {
        preset: "ask",
        allow: ["edit(src/**)"],
        ask: [],
        deny: ["read(~/.ssh/**)"],
      },
    });
  });

  it("is seen by the next load, from this store or another", async () => {
    await store().update(OWNER, (current) => ({ ...current, deny: ["bash"] }));

    await expect(store().load(OWNER)).resolves.toMatchObject({
      deny: ["bash"],
    });
  });

  it("does not write a change that is not valid settings", async () => {
    writeSettings({ permissions: { deny: ["bash"] } });
    const before = fs.readFileSync(filePath, "utf8");

    await expect(
      store().update(OWNER, () => ({ allow: "everything" }) as never),
    ).rejects.toThrow(PermissionSettingsError);

    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("does not overwrite a file it cannot read", async () => {
    writeSettings("{ not json");

    await expect(
      store().update(OWNER, (current) => ({ ...current, allow: ["bash"] })),
    ).rejects.toThrow(/not valid JSON/);

    expect(fs.readFileSync(filePath, "utf8")).toBe("{ not json");
  });

  it("leaves no temporary files behind", async () => {
    await store().update(OWNER, (current) => ({ ...current, deny: ["bash"] }));

    expect(fs.readdirSync(path.dirname(filePath)).sort()).toEqual([
      "settings.json",
      "settings.json.lock",
    ]);
  });
});

describe("concurrent updates", () => {
  it("keeps every rule added by overlapping updates in one process", async () => {
    const stores = [store(), store(), store()];

    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        stores[index % stores.length]!.update(OWNER, (current) => ({
          ...current,
          deny: [...current.deny, `bash(rule-${index})`],
        })),
      ),
    );

    const { deny } = await store().load(OWNER);
    expect([...deny].sort()).toEqual(
      Array.from({ length: 30 }, (_, index) => `bash(rule-${index})`).sort(),
    );
  });

  it("keeps every rule added by several processes at once", async () => {
    const processes = ["a", "b", "c", "d"];
    const perProcess = 12;

    await Promise.all(
      processes.map(
        (prefix) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                "--import",
                "tsx",
                childScript,
                filePath,
                prefix,
                String(perProcess),
              ],
              { stdio: ["ignore", "ignore", "pipe"] },
            );
            let errors = "";
            child.stderr.on("data", (chunk: Buffer) => {
              errors += chunk.toString();
            });
            child.once("error", reject);
            child.once("exit", (code) =>
              code === 0
                ? resolve()
                : reject(
                    new Error(`child ${prefix} exited ${code}: ${errors}`),
                  ),
            );
          }),
      ),
    );

    const { deny } = await store().load(OWNER);
    expect(deny).toHaveLength(processes.length * perProcess);
    expect(new Set(deny).size).toBe(processes.length * perProcess);
    // The file is whole JSON after every write.
    expect(readSettings().permissions).toMatchObject({ allow: [], ask: [] });
  }, 60_000);
});

describe("the mode of the settings file", () => {
  const modeOf = () => fs.statSync(filePath).mode & 0o777;
  let previousUmask: number;

  beforeEach(() => {
    // The common default, under which a new file would be world-readable.
    previousUmask = process.umask(0o022);
  });

  afterEach(() => {
    process.umask(previousUmask);
  });

  const addRule = () =>
    store().update(OWNER, (current) => ({ ...current, deny: ["bash"] }));

  it("is private when the store creates the file", async () => {
    await addRule();

    expect(modeOf()).toBe(0o600);
  });

  it.each([
    ["stays private", 0o600, 0o600],
    ["keeps a stricter mode", 0o400, 0o400],
    ["loses access for other users", 0o644, 0o600],
    ["loses access for other users and the group", 0o664, 0o600],
  ])("%s when a %s file is replaced", async (_label, before, after) => {
    writeSettings({ runtime: {} });
    fs.chmodSync(filePath, before);

    await addRule();

    expect(modeOf()).toBe(after);
    expect(readSettings().permissions).toMatchObject({ deny: ["bash"] });
  });
});

describe("a store that cannot save", () => {
  it("in sandbox mode reads the mounted settings, not the container home", () => {
    const mount = path.join(directory, "app-propio");
    fs.mkdirSync(mount);

    expect(resolveSettingsLocation(mount)).toEqual({
      filePath: path.join(mount, "settings.json"),
      readOnlyReason: expect.stringContaining(
        "edit ~/.propio/settings.json on the host",
      ),
    });
    expect(resolveSettingsLocation(path.join(directory, "absent"))).toEqual({
      filePath: path.join(os.homedir(), ".propio", "settings.json"),
    });
  });

  it("applies the rules it reads, refuses to save, and says why", async () => {
    writeSettings({ permissions: { deny: ["bash(git push:*)"] } });
    const before = fs.readFileSync(filePath, "utf8");
    const readOnly = new FilePermissionStore({
      filePath,
      owner: OWNER,
      readOnlyReason: "sandbox mode reads your settings from a read-only copy",
    });

    await expect(readOnly.load(OWNER)).resolves.toMatchObject({
      deny: ["bash(git push:*)"],
    });
    await expect(readOnly.savingUnavailableReason()).resolves.toMatch(
      /read-only copy/,
    );
    const failure = await readOnly
      .update(OWNER, (current) => ({ ...current, allow: ["bash"] }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PermissionSettingsError);
    expect((failure as Error).message).toBe(
      `Cannot save permissions to ${filePath}: rules cannot be saved: sandbox mode reads your settings from a read-only copy`,
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
  });

  it("can save where the file is writable and locking works", async () => {
    await expect(store().savingUnavailableReason()).resolves.toBeUndefined();
  });
});

describe("an update withdrawn while it waits for the lock", () => {
  it("stores nothing, and a later update still works", async () => {
    writeSettings({ permissions: { deny: ["bash(git push:*)"] } });
    const before = fs.readFileSync(filePath, "utf8");
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockTaken!: () => void;
    const taken = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    // Another writer holds the lock, as a second process or a slow save would.
    const holder = withFileLock(`${filePath}.lock`, async () => {
      lockTaken();
      await held;
    });
    await taken;

    const queued = store().update(
      OWNER,
      (current) => ({ ...current, allow: ["bash"] }),
      { signal: controller.signal },
    );
    const outcome = queued.catch((error: unknown) => error);
    controller.abort(new Error("turn cancelled"));
    release();
    await holder;

    expect(await outcome).toEqual(new Error("turn cancelled"));
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    await store().update(OWNER, (current) => ({ ...current, allow: ["read"] }));
    expect(readSettings().permissions).toMatchObject({ allow: ["read"] });
  });

  it("does not start for a signal that is already aborted", async () => {
    await expect(
      store().update(OWNER, (current) => ({ ...current, allow: ["bash"] }), {
        signal: AbortSignal.abort(new Error("already cancelled")),
      }),
    ).rejects.toThrow("already cancelled");
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
