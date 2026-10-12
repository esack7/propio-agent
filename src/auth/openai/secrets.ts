import { parseProtectedJson } from "./secureFiles.js";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import {
  atomicPrivateWrite,
  checkPrivatePath,
  hasCode,
  privateDirectory,
  readPrivateFile,
} from "./secureFiles.js";

export interface SecretBackend {
  read(id: string): Promise<string | undefined>;
  write(id: string, value: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createOsSecretBackend(): SecretBackend {
  const entry = async (id: string) => {
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry("Propio.OpenAI", id, {
        linux: { store: "secret-service" },
      });
    } catch {
      throw new Error(
        "OS secret storage is unavailable. Explicitly choose --storage protected-file on a supported Unix host.",
      );
    }
  };
  return {
    async read(id: string): Promise<string | undefined> {
      try {
        return (await (await entry(id)).getPassword()) ?? undefined;
      } catch {
        throw new Error(
          "Cannot read OS secret storage. Unlock it or explicitly choose protected-file for a new registration.",
        );
      }
    },
    async write(id: string, value: string): Promise<void> {
      try {
        await (await entry(id)).setPassword(value);
      } catch {
        throw new Error(
          "Cannot persist OpenAI credentials in OS storage. No token was returned to inference.",
        );
      }
    },
    async remove(id: string): Promise<void> {
      try {
        await (await entry(id)).deleteCredential();
      } catch {
        throw new Error(
          "Cannot clear OS credentials. This registration is blocked; unlock the store and retry logout.",
        );
      }
    },
  };
}

export function createProtectedFileBackend(directory: string): SecretBackend {
  const path = (id: string) => {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new Error("Invalid credential reference.");
    return join(directory, `${id}.json`);
  };
  return {
    async read(id: string): Promise<string | undefined> {
      await privateDirectory(directory);
      const value = await readPrivateFile(path(id));
      return value === undefined
        ? undefined
        : (parseProtectedJson(value) as string);
    },
    async write(id: string, value: string): Promise<void> {
      await atomicPrivateWrite(path(id), value);
    },
    async remove(id: string): Promise<void> {
      try {
        await checkPrivatePath(path(id));
        await unlink(path(id));
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
    },
  };
}
