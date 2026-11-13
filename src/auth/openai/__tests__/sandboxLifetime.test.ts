import { jest } from "@jest/globals";
import {
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createSandboxConfigView,
  waitForSandboxOwner,
} from "../sandboxHost.js";

function startSandboxHost(home: string, channel: string) {
  const host = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../sandboxHost.ts", import.meta.url)),
      channel,
    ],
    {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let errors = "";
  host.stderr.on("data", (data: Buffer) => {
    errors += data.toString();
  });
  const exited = new Promise<number | null>((resolve) =>
    host.once("exit", resolve),
  );
  return { host, exited, errors: () => errors };
}

it("creates an empty private configuration view when the source is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "propio-missing-config-"));
  const view = await createSandboxConfigView(join(directory, "absent"));
  try {
    expect(await readdir(view)).toEqual([]);
  } finally {
    await rm(view, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

describe("a settings file that is a symbolic link on the host", () => {
  let directory: string;
  let source: string;
  let views: string[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "propio-linked-settings-"));
    source = join(directory, ".propio");
    await mkdir(source);
    await writeFile(join(source, "providers.json"), "{}");
    views = [];
  });

  afterEach(async () => {
    for (const view of views) await rm(view, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });

  async function viewOf(): Promise<string> {
    const view = await createSandboxConfigView(source);
    views.push(view);
    return view;
  }

  it("reaches the sandbox with its rules, as a plain file", async () => {
    const target = join(directory, "dotfiles-settings.json");
    await writeFile(
      target,
      JSON.stringify({ permissions: { deny: ["bash(git push:*)"] } }),
    );
    await symlink(target, join(source, "settings.json"));

    const view = await viewOf();

    const copied = join(view, "settings.json");
    expect((await lstat(copied)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(copied, "utf8"))).toEqual({
      permissions: { deny: ["bash(git push:*)"] },
    });
  });

  it("still leaves every other link out of the view", async () => {
    const secret = join(directory, "secret.txt");
    await writeFile(secret, "secret");
    await symlink(secret, join(source, "notes.txt"));
    await writeFile(join(source, "settings.json"), "{}");

    const view = await viewOf();

    expect((await readdir(view)).sort()).toEqual([
      "providers.json",
      "settings.json",
    ]);
  });

  it.each([
    ["leads nowhere", undefined, /could not be read as JSON/],
    [
      "leads to something that is not JSON",
      "secret key material",
      /could not be read as JSON/,
    ],
    ["leads to JSON that is not an object", '["a"]', /not a settings object/],
  ])(
    "stops the sandbox before it starts when the link %s",
    async (_label, content, message) => {
      const target = join(directory, "elsewhere.json");
      if (content !== undefined) await writeFile(target, content);
      await symlink(target, join(source, "settings.json"));

      await expect(createSandboxConfigView(source)).rejects.toThrow(message);
    },
  );

  it("never copies what a bad link points to into an error message", async () => {
    const target = join(directory, "elsewhere.json");
    await writeFile(target, "secret key material");
    await symlink(target, join(source, "settings.json"));

    const failure = await createSandboxConfigView(source).catch(
      (error: Error) => error,
    );

    expect((failure as Error).message).not.toContain("secret key material");
  });
});

it("keeps the channel alive beyond eight hours while its owner remains alive", async () => {
  jest.useFakeTimers();
  let finished = false;
  const pending = waitForSandboxOwner().then(() => {
    finished = true;
  });
  try {
    jest.setSystemTime(Date.now() + 9 * 60 * 60 * 1000);
    await jest.advanceTimersByTimeAsync(1000);
    expect(finished).toBe(false);
  } finally {
    process.emit("SIGTERM");
    await pending;
    jest.useRealTimers();
  }
  expect(finished).toBe(true);
});

it.each(["missing-file", "api-default"])(
  "starts and cleans up an API sandbox host with %s",
  async (kind) => {
    const home = await mkdtemp(join(tmpdir(), "propio-api-sandbox-"));
    const channel = join(home, "channel");
    await mkdir(channel);
    await mkdir(join(home, ".propio"));
    if (kind === "api-default")
      await writeFile(
        join(home, ".propio", "providers.json"),
        JSON.stringify({
          default: "api",
          providers: [
            {
              name: "api",
              type: "openai",
              defaultModel: "test",
              models: [
                { key: "test", name: "Test", contextWindowTokens: 128000 },
              ],
            },
          ],
        }),
      );
    const { host, exited, errors } = startSandboxHost(home, channel);
    let view: string | undefined;
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        if ((await readdir(channel)).includes("ready")) break;
        if (host.exitCode !== null) throw new Error(errors());
        await delay(50);
      }
      view = await readFile(join(channel, "config-path"), "utf8");
      expect(await readdir(channel)).not.toContain("broker.json");
      expect(errors()).toBe("");
    } finally {
      host.kill("SIGTERM");
      expect(await exited).toBe(0);
      if (view)
        await expect(readFile(join(channel, "config-path"))).rejects.toThrow();
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.each(["missing-default", "invalid-json", "invalid-settings"])(
  "explains %s without exposing config contents and removes the sandbox view",
  async (kind) => {
    const home = await mkdtemp(join(tmpdir(), "propio-invalid-sandbox-"));
    const channel = join(home, "channel");
    await mkdir(channel);
    await mkdir(join(home, ".propio"));
    const secret = "private-api-key-do-not-print";
    const config = {
      default: kind === "missing-default" ? "missing-provider" : "api",
      providers: [
        {
          name: "api",
          type: "openai",
          apiKey: secret,
          defaultModel: "test",
          models: [{ key: "test", name: "Test", contextWindowTokens: -1 }],
        },
      ],
    };
    await writeFile(
      join(home, ".propio", "providers.json"),
      kind === "invalid-json"
        ? `{"apiKey":"${secret}",`
        : JSON.stringify(config),
    );
    const { host, exited, errors } = startSandboxHost(home, channel);
    try {
      expect(await exited).toBe(1);
      expect(errors()).toContain("~/.propio/providers.json");
      expect(errors()).toContain("No credentials were mounted");
      expect(errors()).not.toContain(secret);
      if (kind === "missing-default") {
        expect(errors()).toContain('Default provider "missing-provider"');
        expect(errors()).toContain('Correct its "default" field');
      } else expect(errors()).toContain("Check its JSON and provider settings");
      expect(await readdir(home)).toEqual([".propio"]);
    } finally {
      host.kill("SIGTERM");
      await exited;
      await rm(home, { recursive: true, force: true });
    }
  },
);
