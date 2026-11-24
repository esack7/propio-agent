import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMcpCredentialStore } from "../mcpCredentialStore.js";

test("private revisions survive restart and unrelated concurrent updates", async () => {
  const home = await mkdtemp(join(tmpdir(), "mcp-home-"));
  const directory = join(home, ".propio", "mcp-auth");
  const key = {
    owner: "local",
    serverName: "docs",
    resource: "https://example.test/mcp",
  };
  try {
    const store = new FileMcpCredentialStore(directory);
    const other = { ...key, serverName: "other" };
    await Promise.all([
      store.compareAndSet(key, 0, {
        tokens: { access_token: "synthetic-access", token_type: "Bearer" },
      }),
      store.compareAndSet(other, 0, {}),
    ]);
    const restarted = new FileMcpCredentialStore(directory);
    expect((await restarted.load(key)).tokens?.access_token).toBe(
      "synthetic-access",
    );
    await restarted.clear(key);
    expect(
      await store.compareAndSet(key, 1, {
        tokens: { access_token: "stale", token_type: "Bearer" },
      }),
    ).toBe(false);
    expect((await store.load(other)).revision).toBe(1);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(directory))
      expect((await stat(join(directory, name))).mode & 0o077).toBe(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("corrupt records can be signed out without restoring stale writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-corrupt-"));
  const key = {
    owner: "local",
    serverName: "docs",
    resource: "https://example.test/mcp",
  };
  const store = new FileMcpCredentialStore(directory);
  try {
    await store.compareAndSet(key, 0, {});
    const file = (await readdir(directory)).find((name) =>
      name.endsWith(".json"),
    )!;
    await writeFile(join(directory, file), "broken synthetic-secret");
    await expect(store.load(key)).rejects.toThrow("/mcp logout");
    await store.clear(key);
    expect(await store.compareAndSet(key, 1, {})).toBe(false);
    const record = await store.load(key);
    expect(await store.compareAndSet(key, record.revision, {})).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent processes sharing a home cannot overwrite the same revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-process-"));
  const key = {
    owner: "local",
    serverName: "docs",
    resource: "https://example.test/mcp",
  };
  const script = `import { FileMcpCredentialStore } from './src/config/mcpCredentialStore.ts';
    const store = new FileMcpCredentialStore(process.argv[1]);
    console.log(await store.compareAndSet(JSON.parse(process.argv[2]), 0, {
      tokens: { access_token: 'synthetic-process', token_type: 'Bearer' }
    }));`;
  try {
    const run = promisify(execFile);
    const results = await Promise.all(
      [0, 1].map(() =>
        run(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            script,
            directory,
            JSON.stringify(key),
          ],
          { env: { ...process.env, HOME: directory } },
        ),
      ),
    );
    expect(results.map((result) => result.stdout.trim()).sort()).toEqual([
      "false",
      "true",
    ]);
    expect(
      (await new FileMcpCredentialStore(directory).load(key)).revision,
    ).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
