import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { withCredentialLock } from "../lock.js";
import { atomicPrivateWrite } from "../secureFiles.js";
import { importPocAccount } from "../migration.js";
import { ChatGptCredentialStore } from "../store.js";
import { guidedOpenAiSetup } from "../setup.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "propio-storage-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("serializes independent OS processes and releases a killed owner without age or PID inference", async () => {
  const path = join(directory, "process.lock");
  const script = `import { withCredentialLock } from ${JSON.stringify(new URL("../lock.ts", import.meta.url).href)}; await withCredentialLock(process.argv[1],async()=>{console.log('locked');setInterval(()=>{},1000);await new Promise(()=>{});});`;
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    script,
    path,
  ]);
  const exit = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.stderr.once("data", (value) => reject(new Error(String(value))));
    });
    const controller = new AbortController();
    const blocked = withCredentialLock(
      path,
      async () => "unexpected",
      controller.signal,
    );
    setTimeout(() => controller.abort(), 150);
    await expect(blocked).rejects.toThrow();
    child.kill("SIGKILL");
    await exit;
    expect(await withCredentialLock(path, async () => "recovered")).toBe(
      "recovered",
    );
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
}, 15000);

it("migrates under both protocols, retains registration/host and retires only the selected source", async () => {
  const sourceDirectory = join(directory, "poc");
  const production = join(directory, "production");
  const hostId = `urn:uuid:${randomUUID()}`;
  const account = {
    clientId: "issued-client",
    subject: "verified-subject",
    idToken: "signed-test-token",
    accessToken: "access-sentinel",
    refreshToken: "refresh-sentinel",
    expiresAt: Date.now() + 3600000,
    scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
  };
  const source = {
    version: 1,
    hostId,
    accounts: {
      default: account,
      unrelated: { ...account, clientId: "other-client" },
    },
  };
  await atomicPrivateWrite(join(sourceDirectory, "auth.json"), source);
  const result = await importPocAccount({
    account: "personal",
    sourceDirectory,
    directory: production,
    secretDirectory: join(directory, "secrets"),
    storage: "protected-file",
    verifyIdentity: async () => {},
  });
  const retired = JSON.parse(
    await readFile(join(sourceDirectory, "auth.json"), "utf8"),
  );
  expect(retired.accounts.default.refreshToken).toBeUndefined();
  expect(retired.accounts.default.clientId).toBe(account.clientId);
  expect(retired.accounts.unrelated.refreshToken).toBe("refresh-sentinel");
  const store = new ChatGptCredentialStore({
    directory: production,
    profile: "personal",
    secretDirectory: join(directory, "secrets"),
    storage: "protected-file",
  });
  const state = (await store.read())!;
  expect(state.hostId).toBe(hostId);
  expect(state.accounts.personal).toMatchObject({
    accountId: result.accountId,
    refreshToken: "refresh-sentinel",
    state: "connected",
  });
});

it("refuses a POC lock collision without copying a second rotating token set", async () => {
  const sourceDirectory = join(directory, "poc");
  await atomicPrivateWrite(join(sourceDirectory, "auth.json"), {});
  await writeFile(join(sourceDirectory, "auth.lock"), "old-owner", {
    mode: 0o600,
  });
  await expect(
    importPocAccount({
      account: "personal",
      sourceDirectory,
      directory: join(directory, "production"),
      secretDirectory: join(directory, "secrets"),
      storage: "protected-file",
    }),
  ).rejects.toThrow("lock is occupied");
});

it("keeps defaults intact for cancelled and session-only API setup", async () => {
  const path = join(directory, "providers.json");
  const existing = {
    default: "existing-api",
    providers: [
      {
        name: "existing-api",
        type: "openai",
        defaultModel: "old",
        models: [{ name: "Old", key: "old", contextWindowTokens: 8192 }],
        apiKey: "api-sentinel",
      },
    ],
  };
  await atomicPrivateWrite(path, existing);
  const cancelled = await guidedOpenAiSetup(
    { ask: async () => "", info: () => {} },
    path,
  );
  expect(cancelled).toBeNull();
  const replies = ["1", "new-model", "16000", "1"];
  const result = await guidedOpenAiSetup(
    { ask: async () => replies.shift()!, info: () => {} },
    path,
  );
  expect(result?.provider.auth).toEqual({ mode: "api-key" });
  expect(result?.persistent).toBe(false);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(existing);
});

it.each([[], ["1"], ["1", "new-model"], ["1", "new-model", "16000"]])(
  "cancels API setup before changing configuration for replies %j",
  async (...answers) => {
    const path = join(directory, "missing-providers.json");
    const replies = answers.flat() as string[];
    const result = await guidedOpenAiSetup(
      { ask: async () => replies.shift() ?? "", info: () => {} },
      path,
    );
    expect(result).toBeNull();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("retains a session selection and reports a failed default save", async () => {
  const parent = join(directory, "not-a-directory");
  await writeFile(parent, "unchanged");
  const replies = ["1", "new-model", "16000", "2"];
  const messages: string[] = [];
  const result = await guidedOpenAiSetup(
    {
      ask: async () => replies.shift() ?? "",
      info: (message) => messages.push(message),
    },
    join(parent, "providers.json"),
  );
  expect(result?.provider.defaultModel).toBe("new-model");
  expect(result?.persistent).toBe(false);
  expect(
    messages.some((message) => message.includes("saved default is unchanged")),
  ).toBe(true);
  expect(await readFile(parent, "utf8")).toBe("unchanged");
});
