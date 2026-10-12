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
    let view: string | undefined;
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        if ((await readdir(channel)).includes("ready")) break;
        if (host.exitCode !== null) throw new Error(errors);
        await delay(50);
      }
      view = await readFile(join(channel, "config-path"), "utf8");
      expect(await readdir(channel)).not.toContain("broker.json");
      expect(errors).toBe("");
    } finally {
      host.kill("SIGTERM");
      expect(await exited).toBe(0);
      if (view)
        await expect(readFile(join(channel, "config-path"))).rejects.toThrow();
      await rm(home, { recursive: true, force: true });
    }
  },
);
