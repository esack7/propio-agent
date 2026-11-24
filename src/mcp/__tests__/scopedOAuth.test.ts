import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  InMemoryMcpCredentialStore,
  McpConnectionManager,
  type McpOAuthInteraction,
} from "../index.js";

async function fixture() {
  let origin = "";
  let refreshes = 0;
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const tokens = new Set<string>();
  const refreshTokens = new Map<string, string>();
  const tokenOwners = new Map<string, string>();
  const sessionOwners = new Map<string, string>();
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const issueTokens = async (req: IncomingMessage) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const params = new URLSearchParams(body);
    const previous = params.get("refresh_token");
    const owner = previous ? refreshTokens.get(previous) : randomUUID();
    if (!owner) throw new Error("Invalid or reused fixture refresh token");
    if (params.get("grant_type") === "refresh_token") {
      refreshTokens.delete(previous!);
      refreshes++;
      started?.();
      if (started)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    }
    const access_token = randomUUID();
    tokens.add(access_token);
    tokenOwners.set(access_token, owner);
    const refresh_token = randomUUID();
    refreshTokens.set(refresh_token, owner);
    return { access_token, token_type: "Bearer", refresh_token };
  };
  const oauthRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const json = (value: unknown) =>
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      return true;
    }
    if (req.url === "/.well-known/oauth-authorization-server") {
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
      return true;
    }
    if (req.url === "/register") {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      json({ ...JSON.parse(body), client_id: randomUUID() });
      return true;
    }
    if (req.url === "/token") {
      json(await issueTokens(req));
      return true;
    }
    return false;
  };
  const server = createServer(async (req, res) => {
    if (await oauthRequest(req, res)) return;
    const token = req.headers.authorization?.slice(7);
    if (!token || !tokens.has(token)) {
      res
        .writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        })
        .end();
      return;
    }
    const id = req.headers["mcp-session-id"];
    if (typeof id === "string" && sessions.has(id)) {
      if (sessionOwners.get(id) !== tokenOwners.get(token)) {
        res.writeHead(403).end();
        return;
      }
      await sessions.get(id)!.handleRequest(req, res);
      return;
    }
    const remote = new McpServer({ name: "protected", version: "1" });
    remote.registerTool("who", {}, async () => ({
      content: [{ type: "text", text: tokenOwners.get(token)! }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
        sessionOwners.set(id, tokenOwners.get(token)!);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    await remote.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    tokens,
    sessions,
    refreshes: () => refreshes,
    pause: () =>
      new Promise<void>((resolve) => {
        started = resolve;
      }),
    resume: () => {
      started = undefined;
      release?.();
    },
    close: async () => {
      await Promise.all([...sessions.values()].map((s) => s.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("isolates owners, serializes rotated refresh, and rejects late responses after clearing", async () => {
  const local = await fixture();
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
    ).rejects.toThrow("authorization required");
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
    await b.clearServerCredentials("protected");
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
      : new Response(null, { status: 401 });
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
        return json({
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
      if (url.endsWith("/token")) return json(await issueTokens(init));
      return resourceResponse(init);
    });
  const adapter = new ScopedMcpOAuth(
    {
      owner: "one",
      store,
      clientMetadata: { redirect_uris: [origin + "/callback"] },
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
    const sibling = new ScopedMcpOAuth(
      {
        owner: "one",
        store,
        clientMetadata: { redirect_uris: [origin + "/callback"] },
      },
      "test",
      origin + "/mcp",
    );
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
    expect(authorizations).toBe(2);
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
    issuer = "http://127.0.0.1:12346";
    await expect(
      adapter.fetch(origin + "/mcp", {
        headers: { authorization: `Bearer access-${sequence}` },
      }),
    ).resolves.toBeDefined();
    await expect(
      adapter.login(
        {
          ...interaction,
          authorize: async () => ({ code: "secret-code", state: "bad" }),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("authorization required");
    expect((await store.load(adapter.key)).tokens).toBeUndefined();
    const cancelled = AbortSignal.abort();
    await expect(adapter.login(interaction, cancelled)).rejects.toThrow(
      "authorization required",
    );
    expect((await store.load(adapter.key)).tokens).toBeUndefined();
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
