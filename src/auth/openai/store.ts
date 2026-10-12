import { parseProtectedJson } from "./secureFiles.js";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { z } from "zod";
import {
  atomicPrivateWrite,
  privateDirectory,
  readPrivateFile,
} from "./secureFiles.js";
import { withCredentialLock } from "./lock.js";
import {
  createOsSecretBackend,
  createProtectedFileBackend,
  type SecretBackend,
} from "./secrets.js";

const accountSchema = z.object({
  version: z.literal(1),
  accountId: z.string().uuid(),
  label: z.string(),
  clientId: z.string().min(1),
  issuer: z.literal("https://auth.openai.com"),
  hostId: z.string().startsWith("urn:uuid:"),
  subject: z.string().optional(),
  email: z.string().optional(),
  storage: z.enum(["os", "protected-file"]),
  generation: z.number().int().nonnegative(),
  state: z.enum([
    "pending",
    "connected",
    "signed-out",
    "refreshing",
    "recovery-required",
    "migration-pending",
  ]),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  expiresAt: z.number().optional(),
  scopes: z.array(z.string()).default([]),
});
export type ChatGptAccount = z.infer<typeof accountSchema>;
function parseAccount(value: string): ChatGptAccount {
  const result = accountSchema.safeParse(parseProtectedJson(value));
  if (!result.success)
    throw new Error(
      "Invalid OpenAI registration or secret record; reauthorization is required.",
    );
  return result.data;
}
function resolveSecret(
  account: ChatGptAccount,
  secret?: ChatGptAccount,
): ChatGptAccount {
  if (!secret || !newerSecret(account, secret))
    return ["refreshing", "recovery-required"].includes(account.state)
      ? { ...account, state: "recovery-required" }
      : account;
  assertSecretIdentity(account, secret);
  if (account.state === "migration-pending")
    return { ...secret, state: "migration-pending" };
  return secret.state === "migration-pending"
    ? { ...secret, state: account.state }
    : secret;
}
function assertSecretIdentity(
  account: ChatGptAccount,
  secret: ChatGptAccount,
): void {
  if (
    secret.accountId !== account.accountId ||
    secret.clientId !== account.clientId ||
    secret.hostId !== account.hostId
  )
    throw new Error("OpenAI credential identity mismatch.");
  if (account.subject && secret.subject !== account.subject)
    throw new Error("OpenAI credential subject mismatch.");
}
function newerSecret(account: ChatGptAccount, secret: ChatGptAccount): boolean {
  if (secret.generation > account.generation) return true;
  return (
    secret.generation === account.generation &&
    !["refreshing", "recovery-required"].includes(account.state)
  );
}
export interface ChatGptStore {
  version: 1;
  hostId: string;
  accounts: Record<string, ChatGptAccount>;
}

export interface StoreOptions {
  directory: string;
  profile?: string;
  storage?: "os" | "protected-file";
  secretDirectory: string;
  backend?: SecretBackend;
}

/** Registry metadata and secrets have separate commit points. Secrets win generation recovery. */
export class ChatGptCredentialStore {
  readonly directory: string;
  readonly profile: string;
  constructor(private readonly options: StoreOptions) {
    this.directory = options.directory;
    this.profile = options.profile ?? "default";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(this.profile))
      throw new Error(
        "Use a short account label with letters, numbers, underscores or hyphens.",
      );
  }
  private key() {
    return createHash("sha256").update(this.profile).digest("hex");
  }
  private metadataPath() {
    return join(this.directory, `${this.key()}.account.json`);
  }
  private backend(account: ChatGptAccount): SecretBackend {
    return (
      this.options.backend ??
      (account.storage === "os"
        ? createOsSecretBackend()
        : createProtectedFileBackend(this.options.secretDirectory))
    );
  }
  async hostId(): Promise<string> {
    return withCredentialLock(join(this.directory, "host.lock"), async () => {
      const path = join(this.directory, "host.json");
      const existing = await readPrivateFile(path);
      if (existing)
        return z
          .string()
          .startsWith("urn:uuid:")
          .parse(parseProtectedJson(existing));
      const hostId = `urn:uuid:${randomUUID()}`;
      await atomicPrivateWrite(path, hostId);
      return hostId;
    });
  }
  async metadata(): Promise<ChatGptAccount | undefined> {
    const value = await readPrivateFile(this.metadataPath());
    if (!value) return undefined;
    return parseAccount(value);
  }
  async read(): Promise<ChatGptStore | undefined> {
    await privateDirectory(this.directory);
    const account = await this.metadata();
    const hostId = account?.hostId ?? (await this.hostId());
    if (!account) return { version: 1, hostId, accounts: {} };
    const value =
      account.state === "signed-out"
        ? undefined
        : await this.backend(account).read(account.accountId);
    const resolved = resolveSecret(
      account,
      value ? parseAccount(value) : undefined,
    );
    return { version: 1, hostId, accounts: { [this.profile]: resolved } };
  }
  newAccount(clientId: string, hostId: string): ChatGptAccount {
    return {
      version: 1,
      accountId: randomUUID(),
      label: this.profile,
      clientId,
      hostId,
      issuer: "https://auth.openai.com",
      storage: this.options.storage ?? "os",
      generation: 0,
      state: "pending",
      scopes: [],
    };
  }
  async write(state: ChatGptStore): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(state.accounts, this.profile))
      return;
    const account = state.accounts[this.profile];
    if (!account) return;
    const committed = { ...account, generation: account.generation + 1 };
    if (committed.accessToken)
      await this.backend(account).write(
        account.accountId,
        JSON.stringify(committed),
      );
    else await this.backend(account).remove(account.accountId);
    await this.writeMetadata(committed);
    Object.assign(account, committed);
  }
  async writeMetadata(account: ChatGptAccount): Promise<void> {
    const {
      accessToken: _a,
      refreshToken: _r,
      idToken: _i,
      ...metadata
    } = account;
    await atomicPrivateWrite(this.metadataPath(), metadata);
  }
  async withLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return withCredentialLock(
      join(this.directory, `${this.key()}.lock`),
      operation,
      signal,
    );
  }
  async accounts(): Promise<ChatGptAccount[]> {
    await privateDirectory(this.directory);
    const paths = (await readdir(this.directory)).filter((name) =>
      name.endsWith(".account.json"),
    );
    return Promise.all(
      paths.map(async (name) =>
        accountSchema.parse(
          parseProtectedJson(
            (await readPrivateFile(join(this.directory, name)))!,
          ),
        ),
      ),
    );
  }
}
