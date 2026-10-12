import { jest } from "@jest/globals";
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  readFile,
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
