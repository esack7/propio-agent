import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { OpenAiAuth } from "../auth.js";
import { ChatGptCredentialStore } from "../store.js";
import { safeManualAuthorizationUrl } from "../browser.js";
import { createProtectedFileBackend } from "../secrets.js";
import { readdir, readFile } from "node:fs/promises";

let directory: string;
let nonce: string;
let challenge: string;
let scopes: string;
let wrongNonce: boolean;
let tokenIssuer: string;
let tokenAudience: string;
let tokenSubject: string;
let tokenExpiry: string;
let tokenRequests: URLSearchParams[];
let remoteStatus: number;
let refreshError: string | undefined;
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let request: typeof fetch;
let opened: URL[];
const client = "oaiapp-test";
const issuer = "https://auth.openai.com";
const planScopes =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

beforeAll(async () => {
  key = await generateKeyPair("RS256");
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "propio-chatgpt-test-"));
  nonce = "";
  challenge = "";
  scopes = planScopes;
  wrongNonce = false;
  tokenIssuer = issuer;
  tokenAudience = client;
  tokenSubject = "user-test";
  tokenExpiry = "1h";
  tokenRequests = [];
  opened = [];
  remoteStatus = 200;
  refreshError = undefined;
  request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("openid-configuration"))
      return Response.json({
        issuer,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
      });
    if (url.endsWith("/jwks"))
      return Response.json({
        keys: [
          {
            ...(await exportJWK(key.publicKey)),
            kid: "test-key",
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    if (url.endsWith("/revoke"))
      return new Response(null, { status: remoteStatus });
    if (url.endsWith("/oauth/token")) {
      const body = new URLSearchParams(String(init?.body));
      tokenRequests.push(body);
      if (body.get("grant_type") === "refresh_token" && refreshError)
        return Response.json({ error: refreshError }, { status: remoteStatus });
      const signed = await new SignJWT({
        nonce: wrongNonce ? "wrong" : nonce,
        storage: "protected-file",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(tokenIssuer)
        .setAudience(tokenAudience)
        .setSubject(tokenSubject)
        .setIssuedAt()
        .setExpirationTime(tokenExpiry)
        .sign(key.privateKey);
      return Response.json({
        access_token: `access-${tokenRequests.length}`,
        refresh_token: `refresh-${tokenRequests.length}`,
        id_token: signed,
        token_type: "Bearer",
        expires_in: 3600,
        scope: scopes,
      });
    }
    throw new Error(`Unexpected mock endpoint: ${url}`);
  }) as typeof fetch;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function auth(profile = "default") {
  return new OpenAiAuth({
    directory,
    secretDirectory: join(directory, "secrets"),
    storage: "protected-file",
    profile,
    fetch: request,
  });
}
async function openBrowser(value: string) {
  const url = new URL(value);
  opened.push(url);
  nonce = url.searchParams.get("nonce")!;
  challenge = url.searchParams.get("code_challenge")!;
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({
    code: "test-code",
    state: url.searchParams.get("state")!,
    client_id: client,
  }).toString();
  const response = await fetch(callback);
  expect(response.status).toBe(200);
}
async function login(profile = "default") {
  await auth(profile).login({ openBrowser });
}

it("completes real loopback OAuth with signed identity and PKCE, then stores protected credentials", async () => {
  await login();
  const body = tokenRequests[0];
  expect(body.get("client_id")).toBe(client);
  expect(body.get("resource")).toBe("https://api.openai.com/v1");
  expect(
    createHash("sha256").update(body.get("code_verifier")!).digest("base64url"),
  ).toBe(challenge);
  expect(opened[0].searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(opened[0].searchParams.get("agent_name_hint")).toBe("Propio");
  expect(await auth().status()).toMatchObject({
    connected: true,
    planUsageEnabled: true,
    storage: "protected-file",
  });
  expect(await auth().getAccessToken()).toBe("access-1");
  const registry = (await readdir(directory)).find((name) =>
    name.endsWith(".account.json"),
  )!;
  expect((await stat(join(directory, registry))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(directory, registry), "utf8")).not.toContain(
    "access-1",
  );
  // mkdtemp already creates an owner-only directory.
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
});

it("rejects an incorrect nonce without storing tokens and retains the issued registration", async () => {
  wrongNonce = true;
  await expect(login()).rejects.toThrow("identity");
  const state = await new ChatGptCredentialStore({
    directory,
    secretDirectory: join(directory, "secrets"),
    storage: "protected-file",
  }).read();
  expect(state?.accounts.default.clientId).toBe(client);
  expect(state?.accounts.default.accessToken).toBeUndefined();
});

it("rejects forged ID-token signatures", async () => {
  const trusted = key;
  const forged = await generateKeyPair("RS256");
  const transport = request;
  const tampered = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const response = await transport(input, init);
    if (!String(input).endsWith("/oauth/token")) return response;
    const tokens = await response.json();
    tokens.id_token = await new SignJWT({ nonce })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(client)
      .setSubject("user-test")
      .setIssuedAt()
      .setExpirationTime(tokenExpiry)
      .sign(forged.privateKey);
    return Response.json(tokens);
  }) as typeof fetch;
  key = trusted;
  await expect(
    new OpenAiAuth({
      directory,
      secretDirectory: join(directory, "secrets"),
      storage: "protected-file",
      fetch: tampered,
    }).login({ openBrowser }),
  ).rejects.toThrow();
  expect(
    (
      await new ChatGptCredentialStore({
        directory,
        secretDirectory: join(directory, "secrets"),
        storage: "protected-file",
      }).read()
    )?.accounts.default.accessToken,
  ).toBeUndefined();
});

it("reuses the client and host on returning sign-in with internal ID hints and safe manual URLs", async () => {
  await login();
  const host = opened[0].searchParams.get("ext_agent_host_id");
  await login();
  expect(opened[1].searchParams.get("client_id")).toBe(client);
  expect(opened[1].searchParams.get("ext_agent_host_id")).toBe(host);
  expect(opened[1].searchParams.has("agent_name_hint")).toBe(false);
  expect(opened[1].searchParams.has("id_token_hint")).toBe(true);
  expect(safeManualAuthorizationUrl(opened[1].href)).not.toContain(
    "id_token_hint",
  );
  expect(safeManualAuthorizationUrl(opened[1].href)).not.toContain(
    "login_hint",
  );
});

it("treats prototype-property labels as new profiles rather than inherited account records", async () => {
  await login("constructor");
  expect(opened[0].searchParams.get("agent_name_hint")).toBe("Propio");
  expect(await auth("constructor").getAccessToken()).toBe("access-1");
});

it("stores identity-only sign-in but refuses inference without plan permission", async () => {
  scopes = "openid profile email";
  await login();
  expect(await auth().status()).toMatchObject({
    connected: true,
    planUsageEnabled: false,
  });
  await expect(auth().getAccessToken()).rejects.toThrow("disabled");
});

it("serializes token rotation across independent clients and retains replacement refresh tokens", async () => {
  await login();
  const store = new ChatGptCredentialStore({
    directory,
    secretDirectory: join(directory, "secrets"),
    storage: "protected-file",
  });
  await store.withLock(async () => {
    const state = (await store.read())!;
    state.accounts.default.expiresAt = 0;
    await store.write(state);
  });
  expect(
    await Promise.all([auth().getAccessToken(), auth().getAccessToken()]),
  ).toEqual(["access-2", "access-2"]);
  expect(tokenRequests).toHaveLength(2);
  expect(tokenRequests[1].get("scope")).toBeNull();
  expect(tokenRequests[1].get("refresh_token")).toBe("refresh-1");
  expect((await store.read())?.accounts.default.refreshToken).toBe("refresh-2");
});

it("clears only the selected profile on terminal refresh failure", async () => {
  await login();
  await login("work");
  refreshError = "invalid_grant";
  remoteStatus = 400;
  await expect(auth().getAccessToken(undefined, true)).rejects.toThrow(
    "expired or were revoked",
  );
  const state = (await new ChatGptCredentialStore({
    directory,
    secretDirectory: join(directory, "secrets"),
    storage: "protected-file",
  }).read())!;
  expect(state.accounts.default.accessToken).toBeUndefined();
  expect(state.accounts.default.clientId).toBe(client);
  const work = new ChatGptCredentialStore({
    directory,
    profile: "work",
    secretDirectory: join(directory, "secrets"),
    storage: "protected-file",
  });
  expect((await work.read())?.accounts.work.accessToken).toBeDefined();
});

it("preserves credentials on a temporary refresh failure", async () => {
  await login();
  refreshError = "temporarily_unavailable";
  remoteStatus = 503;
  await expect(auth().getAccessToken(undefined, true)).rejects.toThrow("503");
  expect(
    (
      await new ChatGptCredentialStore({
        directory,
        secretDirectory: join(directory, "secrets"),
        storage: "protected-file",
      }).read()
    )?.accounts.default.accessToken,
  ).toBe("access-1");
});

it.each(["network", "abort", "timeout", "empty-503"])(
  "retains usable credentials and permits retry after a transient %s refresh failure",
  async (kind) => {
    await login();
    const working = request;
    request = (async () => {
      if (kind === "network") throw new TypeError("Network unavailable");
      if (kind === "abort") throw new DOMException("Cancelled", "AbortError");
      if (kind === "timeout")
        throw new DOMException("Timed out", "TimeoutError");
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    await expect(auth().getAccessToken(undefined, true)).rejects.toThrow();
    expect(await auth().status()).toMatchObject({ state: "connected" });
    expect(await auth().getAccessToken()).toBe("access-1");
    request = working;
    expect(await auth().getAccessToken(undefined, true)).toBe("access-2");
    expect(tokenRequests[1].get("refresh_token")).toBe("refresh-1");
  },
);

it("blocks reuse after a malformed successful rotation response", async () => {
  await login();
  request = (async () =>
    Response.json({ access_token: "possibly-rotated" })) as typeof fetch;
  await expect(auth().getAccessToken(undefined, true)).rejects.toThrow(
    "Sign in again",
  );
  expect((await auth().status()).state).toBe("recovery-required");
});

async function pendingLogin() {
  const controller = new AbortController();
  let started!: (url: string) => void;
  const browser = new Promise<string>((resolve) => {
    started = resolve;
  });
  const pending = auth().login({
    signal: controller.signal,
    openBrowser: async (url) => {
      started(url);
    },
  });
  // Attach rejection handling while the browser flow is pending.
  const result = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  return { controller, result, url: await browser };
}

it("allows token reads and renewal while browser reauthorization is pending", async () => {
  await login();
  const pending = await pendingLogin();
  try {
    expect(
      await Promise.race([
        auth().getAccessToken(undefined, true),
        delay(1500).then(() => {
          throw new Error("Browser flow blocked token renewal");
        }),
      ]),
    ).toBe("access-2");
  } finally {
    pending.controller.abort();
    await pending.result;
  }
  expect(await auth().getAccessToken()).toBe("access-2");
});

it.each(["connected", "signed-out"])(
  "does not resurrect an initially %s registration logged out during pending sign-in",
  async (state) => {
    await login();
    if (state === "signed-out") await auth().logout();
    const pending = await pendingLogin();
    await auth().logout();
    await openBrowser(pending.url);
    expect(await pending.result).toBeInstanceOf(Error);
    expect(await auth().status()).toMatchObject({
      connected: false,
      state: "signed-out",
    });
    expect(tokenRequests).toHaveLength(1);
  },
);

it.each([200, 503])(
  "reports remote revocation accurately and clears local tokens for HTTP %i",
  async (status) => {
    await login();
    remoteStatus = status;
    expect(await auth().logout()).toEqual({
      remoteRevocationConfirmed: status === 200,
    });
    expect(await auth().status()).toMatchObject({ connected: false });
    expect(
      (
        await new ChatGptCredentialStore({
          directory,
          secretDirectory: join(directory, "secrets"),
          storage: "protected-file",
        }).read()
      )?.accounts.default.clientId,
    ).toBe(client);
  },
);

it("rejects invalid callback state, then accepts the valid callback", async () => {
  await auth().login({
    openBrowser: async (value) => {
      const url = new URL(value);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = "code=untrusted&state=wrong&client_id=oaiapp-test";
      expect((await fetch(callback)).status).toBe(400);
      await openBrowser(value);
    },
  });
  expect(await auth().getAccessToken()).toBe("access-1");
});

it("rejects changed client IDs on reauthorization without overwriting the saved account", async () => {
  await login();
  await expect(
    auth().login({
      openBrowser: async (value) => {
        const url = new URL(value);
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({
          code: "code",
          state: url.searchParams.get("state")!,
          client_id: "other-client",
        }).toString();
        expect((await fetch(callback)).status).toBe(400);
      },
    }),
  ).rejects.toThrow("different client");
  expect(await auth().getAccessToken()).toBe("access-1");
});

it("cancels pending browser sign-in and releases its callback and credential lock", async () => {
  const controller = new AbortController();
  await expect(
    auth().login({
      signal: controller.signal,
      openBrowser: async () => {
        controller.abort();
      },
    }),
  ).rejects.toThrow("cancelled");
  await login();
});

it("can show signed-out status without creating a credential record", async () => {
  expect(await auth().status()).toMatchObject({
    connected: false,
    savedProfiles: [],
  });
  expect(
    (
      await new ChatGptCredentialStore({
        directory,
        secretDirectory: join(directory, "secrets"),
        storage: "protected-file",
      }).read()
    )?.accounts,
  ).toEqual({});
});

it("blocks old rotating tokens after a crash marker and permits reauthorization", async () => {
  await login();
  const store = new ChatGptCredentialStore({
    directory,
    secretDirectory: join(directory, "secrets"),
    storage: "protected-file",
  });
  const account = (await store.read())!.accounts.default;
  await store.writeMetadata({ ...account, state: "refreshing" });
  await expect(auth().getAccessToken()).rejects.toThrow("uncertain");
  expect(tokenRequests).toHaveLength(1);
  await login();
  expect(await auth().getAccessToken()).toBe("access-2");
});

it("recovers a newer whole secret generation after metadata commit failure", async () => {
  await login();
  const store = new ChatGptCredentialStore({
    directory,
    secretDirectory: join(directory, "secrets"),
    storage: "protected-file",
  });
  const state = (await store.read())!;
  const account = state.accounts.default;
  await store.writeMetadata({ ...account, state: "refreshing" });
  await createProtectedFileBackend(join(directory, "secrets")).write(
    account.accountId,
    JSON.stringify({
      ...account,
      generation: account.generation + 1,
      accessToken: "new-access",
      refreshToken: "new-refresh",
    }),
  );
  expect(await auth().getAccessToken()).toBe("new-access");
  expect(tokenRequests).toHaveLength(1);
});

it("does not return rotated credentials when durable persistence fails", async () => {
  const backend = createProtectedFileBackend(join(directory, "secrets"));
  const clientAuth = new OpenAiAuth({
    directory,
    secretDirectory: join(directory, "secrets"),
    storage: "protected-file",
    backend,
    fetch: request,
  });
  await clientAuth.login({ openBrowser });
  backend.write = async () => {
    throw new Error("disk full with secret-should-not-leak");
  };
  await expect(clientAuth.getAccessToken(undefined, true)).rejects.toThrow(
    "durably saved",
  );
  await expect(clientAuth.getAccessToken()).rejects.toThrow("uncertain");
  expect(tokenRequests).toHaveLength(2);
});

it.each(["issuer", "audience", "expiry"])(
  "rejects an invalid signed identity %s",
  async (field) => {
    if (field === "issuer") tokenIssuer = "https://untrusted.example";
    if (field === "audience") tokenAudience = "other-client";
    if (field === "expiry") tokenExpiry = "-1h";
    await expect(login()).rejects.toThrow();
    expect((await auth().status()).connected).toBe(false);
  },
);

it("rejects a changed verified subject on refresh and blocks ambiguous rotated credentials", async () => {
  await login();
  tokenSubject = "another-user";
  await expect(auth().getAccessToken(undefined, true)).rejects.toThrow(
    "Sign in again",
  );
  expect((await auth().status()).state).toBe("recovery-required");
  await expect(auth().getAccessToken()).rejects.toThrow("Sign in again");
});
