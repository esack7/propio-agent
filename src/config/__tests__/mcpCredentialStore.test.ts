import { mkdtemp, rm, stat, readdir } from "node:fs/promises";
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
