import { oauthFixture } from "./fixtures/oauth.js";
import {
  InMemoryMcpCredentialStore,
  McpConnectionManager,
  type McpOAuthInteraction,
} from "../index.js";

it("isolates owners, serializes rotated refresh, and rejects late responses after clearing", async () => {
  const local = await oauthFixture();
  const store = new InMemoryMcpCredentialStore();
  const create = (owner: string, path = "/mcp", loginTimeoutMs = 1000) =>
    new McpConnectionManager({
      config: {
        mcpServers: {
          protected: { transport: "streamable-http", url: local.origin + path },
        },
      },
      clientIdentity: { name: "test", version: "1" },
      connectTimeoutMs: 100,
      loginTimeoutMs,
      oauth: {
        owner,
        store,
        clientMetadata: {
          redirect_uris: ["http://127.0.0.1/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
      },
    });
  const a = create("a");
  const b = create("b");
  const sibling = create("a");
  const changed = create("a", "/other");
  const slow = create("slow");
  const expired = create("expired", "/mcp", 10);
  const interaction: McpOAuthInteraction = {
    redirectUrl: "http://127.0.0.1/callback",
    authorize: async (url) => ({
      code: "synthetic-code",
      state: url.searchParams.get("state")!,
    }),
  };
  const key = (owner: string) => ({
    owner,
    serverName: "protected",
    resource: local.origin + "/mcp",
  });
  const call = (m: McpConnectionManager) =>
    m.executeToolWithStatus("mcp__protected__who", {});
  try {
    const delayed: McpOAuthInteraction = {
      ...interaction,
      authorize: async (url, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 150);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
        return { code: "synthetic", state: url.searchParams.get("state")! };
      },
    };
    await slow.loginServer("protected", delayed, new AbortController().signal);
    await slow.close();
    await expect(
      expired.loginServer("protected", delayed, new AbortController().signal),
    ).rejects.toThrow("cancelled or timed out");
    await Promise.all([a.initialize(), b.initialize()]);
    expect(a.getServerSummaries()[0].lastError).toContain("sign in explicitly");
    await Promise.all([
      a.loginServer("protected", interaction, new AbortController().signal),
      b.loginServer("protected", interaction, new AbortController().signal),
    ]);
    expect((await store.load(key("a"))).tokens).not.toEqual(
      (await store.load(key("b"))).tokens,
    );
    expect(local.sessions.size).toBe(2);
    expect((await call(a)).status).toBe("success");
    expect((await call(b)).status).toBe("success");
    expect((await call(a)).content).not.toBe((await call(b)).content);
    await sibling.initialize();
    const before = (await store.load(key("a"))).tokens!;
    local.tokens.delete(before.access_token);
    const paused = local.pause();
    const reconnects = Promise.all([
      a.reconnectServer("protected"),
      sibling.reconnectServer("protected"),
    ]);
    await paused;
    expect((await call(b)).status).toBe("success");
    await a.close();
    local.resume();
    await reconnects;
    expect(local.refreshes()).toBe(1);
    expect((await store.load(key("a"))).tokens?.refresh_token).not.toBe(
      before.refresh_token,
    );
    await changed.initialize();
    expect(changed.listTools()).toHaveLength(0);
    const current = (await store.load(key("a"))).tokens!;
    local.tokens.delete(current.access_token);
    const late = local.pause();
    const pending = sibling.reconnectServer("protected");
    await late;
    await sibling.clearServerCredentials("protected");
    local.resume();
    await pending;
    expect((await store.load(key("a"))).tokens).toBeUndefined();
    expect(sibling.listTools()).toHaveLength(0);
    expect((await call(b)).status).toBe("success");
    await a.close();
    expect((await call(b)).status).toBe("success");
    let authorized = false;
    const wrong: McpOAuthInteraction = {
      ...interaction,
      authorize: async () => {
        authorized = true;
        return { code: "secret-code", state: "wrong" };
      },
    };
    await expect(
      b.loginServer("protected", wrong, new AbortController().signal),
    ).rejects.toThrow("authorization required");
    expect(authorized).toBe(true);
    const sessionCount = local.sessions.size;
    let releaseDisposal!: () => void;
    let notifyDisposal!: () => void;
    const disposing = new Promise<void>((resolve) => {
      notifyDisposal = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    local.holdDisposal(async () => {
      notifyDisposal();
      await held;
    });
    const clearing = b.clearServerCredentials("protected");
    await disposing;
    const reconnecting = b.reconnectServer("protected");
    const enabling = b.setServerEnabled("protected", true);
    releaseDisposal();
    await Promise.all([clearing, reconnecting, enabling]);
    expect(b.getServerSummaries()[0].status).not.toBe("connected");
    expect(b.getServerSummaries()[0].lastError).toContain("sign in explicitly");
    expect(b.listTools()).toHaveLength(0);
    expect(local.sessions.size).toBe(sessionCount - 1);
  } finally {
    local.resume();
    await Promise.all([
      a.close(),
      b.close(),
      sibling.close(),
      changed.close(),
      slow.close(),
      expired.close(),
    ]);
    await local.close();
  }
});

it("uses SDK PKCE and refresh rotation with injected HTTP responses", async () => {
  const { jest } = await import("@jest/globals");
  const { ScopedMcpOAuth } = await import("../oauth.js");
  const store = new InMemoryMcpCredentialStore();
  const origin = "http://127.0.0.1:12345";
  let sequence = 0;
  let validAccess = true;
  let refreshes = 0;
  let delay: Promise<void> | undefined;
  let notify: (() => void) | undefined;
  let issuer = origin;
  let requiredScope: string | undefined;
  let authorizations = 0;
  let metadataFailure = false;
  let rejectCode = false;
  const issueTokens = async (init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body));
    if (params.get("grant_type") === "refresh_token") {
      refreshes++;
      expect(params.get("refresh_token")).toBe(`refresh-${sequence}`);
      notify?.();
      await delay;
      expect(init?.signal?.aborted).toBe(false);
    } else {
      expect(params.get("code_verifier")?.length).toBeGreaterThan(20);
    }
    sequence++;
    validAccess = true;
    return {
      access_token: `access-${sequence}`,
      refresh_token: `refresh-${sequence}`,
      token_type: "Bearer",
    };
  };
  const resourceResponse = (init?: RequestInit) => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    if (requiredScope)
      return new Response(null, {
        status: 403,
        headers: {
          "www-authenticate":
            'Bearer error="insufficient_scope", scope="expanded"',
        },
      });
    return validAccess &&
      new Headers(init?.headers).get("authorization") ===
        `Bearer access-${sequence}`
      ? json({ ok: true })
      : new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/custom-metadata"`,
          },
        });
  };
  const tokenResponse = async (init?: RequestInit) => {
    if (
      rejectCode &&
      new URLSearchParams(String(init?.body)).get("grant_type") ===
        "authorization_code"
    )
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      });
    return new Response(JSON.stringify(await issueTokens(init)), {
      headers: { "content-type": "application/json" },
    });
  };
  const mock = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      if (url.includes("oauth-protected-resource"))
        return new Response(null, { status: 404 });
      if (url.endsWith("/custom-metadata"))
        return metadataFailure
          ? new Response(null, { status: 503 })
          : json({
              resource: origin + "/mcp",
              authorization_servers: [issuer],
            });
      if (url.includes("oauth-authorization-server"))
        return json({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          registration_endpoint: issuer + "/register",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      if (url.endsWith("/register"))
        return json({
          ...JSON.parse(String(init?.body)),
          client_id: "synthetic-client",
        });
      if (url.endsWith("/token")) return tokenResponse(init);
      return resourceResponse(init);
    });
  const adapter = new ScopedMcpOAuth(
    {
      owner: "one",
      store,
      clientMetadata: { redirect_uris: [] },
    },
    "test",
    origin + "/mcp",
  );
  const interaction: McpOAuthInteraction = {
    redirectUrl: origin + "/callback",
    authorize: async (url) => {
      authorizations++;
      if (requiredScope)
        expect(url.searchParams.get("scope")).toBe(requiredScope);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      return { code: "synthetic-code", state: url.searchParams.get("state")! };
    },
  };
  try {
    await adapter.login(interaction, new AbortController().signal);
    expect((await store.load(adapter.key)).tokens?.refresh_token).toBe(
      "refresh-1",
    );
    const healthy = await store.load(adapter.key);
    rejectCode = true;
    await expect(
      adapter.login(interaction, new AbortController().signal),
    ).rejects.toThrow("authorization required");
    expect(await store.load(adapter.key)).toEqual(healthy);
    rejectCode = false;
    metadataFailure = true;
    validAccess = false;
    await expect(
      adapter.fetch(origin + "/mcp", {
        headers: { authorization: "Bearer access-1" },
      }),
    ).rejects.toThrow("authorization required");
    expect(await store.load(adapter.key)).toEqual(healthy);
    metadataFailure = false;
    const sibling = new ScopedMcpOAuth(
      {
        owner: "one",
        store,
        clientMetadata: { redirect_uris: [] },
      },
      "test",
      origin + "/mcp",
    );
    let finishLogin!: () => void;
    let enteredLogin!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredLogin = resolve;
    });
    const loginController = new AbortController();
    const waiting = adapter.login(
      {
        ...interaction,
        authorize: async (url) => {
          enteredLogin();
          await new Promise<void>((resolve) => {
            finishLogin = resolve;
          });
          return { code: "synthetic", state: url.searchParams.get("state")! };
        },
      },
      loginController.signal,
    );
    const staleLogin = expect(waiting).rejects.toThrow(
      "authorization required",
    );
    await entered;
    validAccess = false;
    const controller = new AbortController();
    const init = { headers: { authorization: "Bearer access-1" } };
    let resume!: () => void;
    delay = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const refreshing = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const requests = Promise.all([
      adapter.fetch(origin + "/mcp", { ...init, signal: controller.signal }),
      sibling.fetch(origin + "/mcp", init),
    ]);
    await refreshing;
    controller.abort();
    resume();
    await requests;
    loginController.abort();
    finishLogin();
    await staleLogin;
    delay = undefined;
    notify = undefined;
    expect(
      (
        await sibling.fetch(origin + "/mcp", {
          headers: { authorization: "Bearer access-2" },
        })
      ).ok,
    ).toBe(true);
    expect(refreshes).toBe(1);
    expect((await store.load(adapter.key)).tokens?.refresh_token).toBe(
      "refresh-2",
    );
    requiredScope = "expanded";
    await expect(
      adapter.fetch(origin + "/mcp", {
        headers: { authorization: "Bearer access-2" },
      }),
    ).rejects.toThrow("authorization required");
    await adapter.login(interaction, new AbortController().signal);
    expect(authorizations).toBe(3);
    requiredScope = undefined;
    validAccess = false;
    let release!: () => void;
    delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const pending = adapter.fetch(origin + "/mcp", {
      headers: { authorization: "Bearer access-3" },
    });
    const rejected = expect(pending).rejects.toThrow("authorization required");
    await started;
    await store.clear(adapter.key);
    release();
    await rejected;
    expect((await store.load(adapter.key)).tokens).toBeUndefined();
    delay = undefined;
    notify = undefined;
    await adapter.login(interaction, new AbortController().signal);
    await expect(
      adapter.login(
        {
          ...interaction,
          authorize: async () => ({ code: "secret-code", state: "bad" }),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("authorization required");
    expect((await store.load(adapter.key)).tokens).toBeDefined();
    const cancelled = AbortSignal.abort();
    await expect(adapter.login(interaction, cancelled)).rejects.toThrow(
      "authorization required",
    );
    expect((await store.load(adapter.key)).tokens).toBeDefined();
    const registrations = mock.mock.calls.filter(([url]) =>
      String(url).endsWith("/register"),
    ).length;
    issuer = "http://127.0.0.1:12346";
    validAccess = false;
    await expect(
      adapter.fetch(origin + "/mcp", {
        headers: { authorization: `Bearer access-${sequence}` },
      }),
    ).rejects.toThrow("authorization required");
    expect((await store.load(adapter.key)).tokens).toBeUndefined();
    expect(
      mock.mock.calls.filter(([url]) => String(url).endsWith("/register")),
    ).toHaveLength(registrations);
  } finally {
    mock.mockRestore();
  }
});

it("keeps revision updates atomic and preserves unrelated owners and endpoints", async () => {
  const store = new InMemoryMcpCredentialStore();
  const key = {
    owner: "one",
    serverName: "same",
    resource: "https://example.com/mcp",
  };
  const second = { ...key, owner: "two" };
  const moved = { ...key, resource: "https://example.com/other" };
  const grant = { tokens: { access_token: "synthetic", token_type: "Bearer" } };
  expect(await store.compareAndSet(second, 0, grant)).toBe(true);
  expect(await store.compareAndSet(moved, 0, grant)).toBe(true);
  const competing = await Promise.all([
    store.compareAndSet(key, 0, grant),
    store.compareAndSet(key, 0, grant),
  ]);
  expect(competing).toEqual([true, false]);
  const loaded = await store.load(key);
  loaded.tokens!.access_token = "caller mutation";
  expect((await store.load(key)).tokens?.access_token).toBe("synthetic");
  await store.clear(key);
  expect(await store.compareAndSet(key, loaded.revision, grant)).toBe(false);
  expect((await store.load(second)).tokens).toEqual(grant.tokens);
  expect((await store.load(moved)).tokens).toEqual(grant.tokens);
});

it.each([
  "issuer",
  "authorize",
  "register",
  "token",
  "register-error",
  "token-error",
])(
  "rejects unsafe OAuth %s without exposing response bodies",
  async (failure) => {
    const { jest } = await import("@jest/globals");
    const origin = "https://protected.example";
    const marker = "synthetic-secret-code-verifier";
    const requested: string[] = [];
    let authorized = false;
    const endpoint = (name: string) =>
      `${failure === name ? "http://unsafe.example" : origin}/${name}`;
    const mock = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        requested.push(url);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
          });
        if (url.includes("oauth-protected-resource"))
          return json({
            resource: origin + "/mcp",
            authorization_servers: [
              failure === "issuer" ? "http://unsafe.example" : origin,
            ],
          });
        if (url.includes("oauth-authorization-server"))
          return json({
            issuer: origin,
            authorization_endpoint: endpoint("authorize"),
            token_endpoint: endpoint("token"),
            registration_endpoint: endpoint("register"),
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        if (url.endsWith("/register"))
          return failure === "register-error"
            ? new Response(marker, { status: 500 })
            : json({
                client_id: "synthetic-client",
                redirect_uris: ["http://127.0.0.1/callback"],
              });
        return new Response(marker, { status: 500 });
      });
    const manager = new McpConnectionManager({
      config: {
        mcpServers: {
          test: { transport: "streamable-http", url: origin + "/mcp" },
        },
      },
      clientIdentity: { name: "test", version: "1" },
      oauth: {
        owner: "owner",
        store: new InMemoryMcpCredentialStore(),
        clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"] },
      },
    });
    try {
      await expect(
        manager.loginServer(
          "test",
          {
            redirectUrl: "http://127.0.0.1/callback",
            authorize: async (url) => {
              authorized = true;
              return { code: marker, state: url.searchParams.get("state")! };
            },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("MCP authorization required; sign in explicitly");
      expect(
        requested.some((url) => url.startsWith("http://unsafe.example")),
      ).toBe(false);
      if (["issuer", "authorize", "register"].includes(failure)) {
        expect(authorized).toBe(false);
        expect(requested.some((url) => url.endsWith("/token"))).toBe(false);
      }
    } finally {
      await manager.close();
      mock.mockRestore();
    }
  },
);
