import { createHash } from "node:crypto";
import { mkdir, chmod, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { withFileLock } from "./fileLock.js";
import { writeJsonFileAtomic } from "./jsonFile.js";
import { McpAuthorizationError } from "../mcp/oauth.js";
import type {
  McpCredentialKey,
  McpCredentialRecord,
  McpCredentialStore,
} from "../mcp/oauth.js";

/** Private atomic revisions; authorization locks never block logout writes. */
export class FileMcpCredentialStore implements McpCredentialStore {
  constructor(
    private readonly directory = join(homedir(), ".propio", "mcp-auth"),
  ) {}
  private id(key: McpCredentialKey): string {
    return createHash("sha256")
      .update(JSON.stringify([key.owner, key.serverName, key.resource]))
      .digest("hex");
  }
  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink())
      throw new Error("MCP credential directory must not be a symbolic link");
    await chmod(this.directory, 0o700);
  }
  private async read(id: string): Promise<McpCredentialRecord> {
    try {
      const value = JSON.parse(
        await readFile(join(this.directory, `${id}.json`), "utf8"),
      ) as McpCredentialRecord;
      if (!Number.isSafeInteger(value.revision) || value.revision < 0)
        throw new Error();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { revision: 0 };
      throw new McpAuthorizationError(
        "Cannot read MCP credentials; run /mcp logout <server> to reset this endpoint, then sign in again",
      );
    }
  }
  async load(key: McpCredentialKey): Promise<McpCredentialRecord> {
    try {
      if ((await lstat(this.directory)).isSymbolicLink())
        throw new McpAuthorizationError(
          "MCP credential directory must not be a symbolic link",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.read(this.id(key));
  }
  private async update(
    key: McpCredentialKey,
    change: (current: McpCredentialRecord) => McpCredentialRecord | undefined,
    recover = false,
  ): Promise<boolean> {
    await this.prepare();
    const id = this.id(key);
    return withFileLock(join(this.directory, `${id}.write.lock`), async () => {
      let current: McpCredentialRecord;
      try {
        current = await this.read(id);
      } catch (error) {
        if (!recover || !(error instanceof McpAuthorizationError)) throw error;
        // A fresh, non-reused revision invalidates every pre-corruption writer.
        current = {
          revision: Date.now() * 1024 + Math.floor(Math.random() * 1024),
        };
      }
      const next = change(current);
      if (!next) return false;
      writeJsonFileAtomic(join(this.directory, `${id}.json`), id, next, {
        private: true,
      });
      return true;
    });
  }
  compareAndSet(
    key: McpCredentialKey,
    revision: number,
    value: Omit<McpCredentialRecord, "revision">,
  ): Promise<boolean> {
    return this.update(key, (current) =>
      current.revision === revision
        ? { ...value, revision: revision + 1 }
        : undefined,
    );
  }
  async clear(key: McpCredentialKey): Promise<void> {
    await this.update(
      key,
      (current) => ({ revision: current.revision + 1 }),
      true,
    );
  }
  async withLock<T>(
    key: McpCredentialKey,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.prepare();
    return withFileLock(
      join(this.directory, `${this.id(key)}.grant.lock`),
      async () => {
        signal?.throwIfAborted();
        return operation();
      },
      { timeoutMs: 310_000 },
    );
  }
}
