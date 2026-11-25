import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ScopedSessionStore, type StoreBackend } from "./storeAdapters.js";
import type { SessionScope, SessionStoreIdentity } from "./stores.js";
import { isSafeSessionId } from "./sessionId.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function checkPath(target: string, directory: boolean): boolean {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return false;
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  )
    throw new Error(`Unsafe session store path: ${target}`);
  return true;
}

/** Explicit root only. Uses private snapshot JSON and append-only JSONL files.
 * No CLI discovery, migration, locking, or torn-write recovery is performed.
 * The host must serialize writers, including across store instances/processes.
 */
export class FileSessionStore extends ScopedSessionStore {
  constructor(private readonly root: string) {
    super();
    if (!path.isAbsolute(root))
      throw new TypeError("Session store root must be absolute");
    this.root = path.resolve(root);
  }

  private scopeDirectory(scope: SessionScope): string {
    return path.join(this.root, hash(scope.owner), hash(scope.workspace));
  }

  private directories(identity: SessionStoreIdentity): string[] {
    const owner = path.join(this.root, hash(identity.owner));
    return [
      this.root,
      owner,
      this.scopeDirectory(identity),
      path.join(this.scopeDirectory(identity), identity.sessionId),
    ];
  }

  private checkDirectories(directories: string[], create: boolean): boolean {
    for (const directory of directories) {
      if (!checkPath(directory, true)) {
        if (!create) return false;
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      }
    }
    return true;
  }

  protected backend(identity: SessionStoreIdentity): StoreBackend {
    const directories = this.directories(identity);
    const directory = directories[directories.length - 1];
    const resolve = (key: string, create: boolean): string | undefined => {
      const parents = key.startsWith("traces/")
        ? [...directories, path.join(directory, "traces")]
        : directories;
      if (!this.checkDirectories(parents, create)) return undefined;
      const target = path.join(directory, key);
      checkPath(target, false);
      return target;
    };
    return {
      read: (key) => {
        const target = resolve(key, false);
        return target && fs.existsSync(target)
          ? fs.readFileSync(target, "utf8")
          : undefined;
      },
      replace: (key, content) => {
        const target = resolve(key, true)!;
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
          fs.renameSync(temporary, target);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      },
      append: (key, content) => {
        const target = resolve(key, true)!;
        const fd = fs.openSync(target, "a", 0o600);
        try {
          fs.writeFileSync(fd, content);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      },
      list: (prefix) => {
        if (
          !this.checkDirectories(
            [...directories, path.join(directory, "traces")],
            false,
          )
        )
          return [];
        return fs
          .readdirSync(path.join(directory, "traces"))
          .filter((name) => {
            if (!name.endsWith(".jsonl") || !isSafeSessionId(name.slice(0, -6)))
              return false;
            checkPath(path.join(directory, "traces", name), false);
            return true;
          })
          .map((name) => `${prefix}${name}`);
      },
    };
  }

  protected sessionIds(scope: SessionScope): string[] {
    const directories = this.directories({
      ...scope,
      sessionId: "unused",
    }).slice(0, -1);
    if (!this.checkDirectories(directories, false)) return [];
    const directory = this.scopeDirectory(scope);
    return fs.readdirSync(directory).filter((name) => {
      if (!isSafeSessionId(name)) return false;
      return checkPath(path.join(directory, name), true);
    });
  }
}
