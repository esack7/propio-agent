import { parseProtectedJson } from "./secureFiles.js";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { ChatGptCredentialStore } from "./store.js";
import {
  atomicPrivateWrite,
  privateDirectory,
  readPrivateFile,
} from "./secureFiles.js";
import { withCredentialLock } from "./lock.js";

const pocAccountSchema = z.object({
  clientId: z.string().min(1),
  subject: z.string().optional(),
  email: z.string().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  expiresAt: z.number().optional(),
  scopes: z.array(z.string()),
});
const pocSchema = z.object({
  version: z.literal(1),
  hostId: z.string().startsWith("urn:uuid:"),
  accounts: z.record(z.string(), pocAccountSchema),
});

/** Verify the retained signed identity at issuance time; migration may follow access-token expiry. */
async function verifyPocIdentity(
  account: z.infer<typeof pocAccountSchema>,
): Promise<void> {
  if (
    !account.idToken ||
    !account.subject ||
    account.clientId === "dynamic_agent_client"
  )
    throw new Error(
      "POC identity/registration is incomplete. Use a fresh production sign-in.",
    );
  const keys = createRemoteJWKSet(
    new URL("https://auth.openai.com/.well-known/jwks.json"),
  );
  const issued = decodeJwt(account.idToken).iat;
  if (!issued) throw new Error("POC identity has no issued-at proof.");
  const { payload } = await jwtVerify(account.idToken, keys, {
    issuer: "https://auth.openai.com",
    audience: account.clientId,
    algorithms: ["RS256", "ES256"],
    requiredClaims: ["sub", "iat", "exp"],
    currentDate: new Date(issued * 1000),
  });
  if (payload.sub !== account.subject)
    throw new Error("POC identity does not match its saved registration.");
}

/** Explicit invocation only. Destination remains inference-blocked until source retirement. */
export async function importPocAccount(options: {
  account: string;
  sourceAccount?: string;
  storage?: "os" | "protected-file";
  sourceDirectory?: string;
  directory?: string;
  secretDirectory?: string;
  verifyIdentity?: typeof verifyPocIdentity;
}): Promise<{ accountId: string; label: string }> {
  const source =
    options.sourceDirectory ??
    join(homedir(), ".propio", "poc", "openai-subscription");
  const directory =
    options.directory ?? join(homedir(), ".propio", "auth", "openai");
  const target = new ChatGptCredentialStore({
    directory,
    profile: options.account,
    storage: options.storage,
    secretDirectory:
      options.secretDirectory ??
      join(homedir(), ".local", "share", "propio", "openai-secrets"),
  });
  await privateDirectory(source);
  // The POC uses exclusive-create, never a native advisory lock. Participate in its exact protocol.
  let sourceLock;
  try {
    sourceLock = await open(join(source, "auth.lock"), "wx", 0o600);
  } catch {
    throw new Error(
      "POC credential lock is occupied. Stop its process and resolve stale ownership manually; migration did not run.",
    );
  }
  try {
    return await target.withLock(() => transferPoc(options, source, target));
  } finally {
    await sourceLock.close();
    await unlink(join(source, "auth.lock"));
  }
}

async function transferPoc(
  options: Parameters<typeof importPocAccount>[0],
  source: string,
  target: ChatGptCredentialStore,
): Promise<{ accountId: string; label: string }> {
  const sourceFile = join(source, "auth.json");
  const { state, sourceLabel, account } = await readSelectedPoc(
    sourceFile,
    options.sourceAccount ?? "default",
  );
  const existing = await target.metadata();
  assertSameRegistration(existing, account, state.hostId);
  const journal = join(
    target.directory,
    `${existing?.accountId ?? options.account}.migration.json`,
  );
  if (account.refreshToken) {
    await stageAndRetire(
      options,
      sourceFile,
      target,
      state,
      account,
      existing,
      sourceLabel,
      journal,
    );
  } else if (existing?.state !== "migration-pending")
    throw new Error(
      "POC tokens were already cleared; use production sign-in or resume the pending migration.",
    );
  const committed = (await target.metadata())!;
  await target.writeMetadata({ ...committed, state: "connected" });
  await atomicPrivateWrite(journal, {
    version: 1,
    sourceLabel,
    accountId: committed.accountId,
    stage: "complete",
  });
  return { accountId: committed.accountId, label: target.profile };
}

function assertSameRegistration(
  existing: Awaited<ReturnType<ChatGptCredentialStore["metadata"]>>,
  account: z.infer<typeof pocAccountSchema>,
  hostId: string,
): void {
  if (
    existing &&
    (existing.clientId !== account.clientId ||
      existing.subject !== account.subject ||
      existing.hostId !== hostId)
  )
    throw new Error(
      "Production label belongs to another registration. Choose a different label; no credentials changed.",
    );
}

async function preserveMigrationHost(
  target: ChatGptCredentialStore,
  hostId: string,
): Promise<void> {
  await withCredentialLock(join(target.directory, "host.lock"), async () => {
    const accounts = await target.accounts();
    if (accounts.some((account) => account.hostId !== hostId))
      throw new Error(
        "Production registrations use a different host identity. Keep the POC separate and use production sign-in.",
      );
    await atomicPrivateWrite(join(target.directory, "host.json"), hostId);
  });
}

async function stageAndRetire(
  options: Parameters<typeof importPocAccount>[0],
  sourceFile: string,
  target: ChatGptCredentialStore,
  state: z.infer<typeof pocSchema>,
  account: z.infer<typeof pocAccountSchema>,
  existing: Awaited<ReturnType<ChatGptCredentialStore["metadata"]>>,
  sourceLabel: string,
  journal: string,
): Promise<void> {
  await (options.verifyIdentity ?? verifyPocIdentity)(account);
  await preserveMigrationHost(target, state.hostId);
  const staged = {
    ...(existing ?? target.newAccount(account.clientId, state.hostId)),
    ...account,
    state: "migration-pending" as const,
  };
  await atomicPrivateWrite(journal, {
    version: 1,
    sourceLabel,
    accountId: staged.accountId,
    stage: "staging",
  });
  await target.write({
    version: 1,
    hostId: state.hostId,
    accounts: { [target.profile]: staged },
  });
  const {
    accessToken: _a,
    refreshToken: _r,
    idToken: _i,
    expiresAt: _e,
    ...retained
  } = account;
  state.accounts[sourceLabel] = { ...retained, scopes: [] };
  await atomicPrivateWrite(sourceFile, state);
}

async function readSelectedPoc(sourceFile: string, sourceLabel: string) {
  const raw = await readPrivateFile(sourceFile);
  const parsed = pocSchema.safeParse(raw ? parseProtectedJson(raw) : undefined);
  if (!parsed.success)
    throw new Error(
      "POC credential format is invalid; use production sign-in.",
    );
  if (!Object.prototype.hasOwnProperty.call(parsed.data.accounts, sourceLabel))
    throw new Error("Selected POC profile is missing.");
  return {
    state: parsed.data,
    sourceLabel,
    account: parsed.data.accounts[sourceLabel],
  };
}
