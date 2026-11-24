import { InMemoryMcpCredentialStore } from "../oauth.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  McpError,
  ErrorCode,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpManager } from "../manager.js";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpConnectionManager } from "../connectionManager.js";
import { validateMcpConfig } from "../validation.js";

it("lists and calls mixed transports, persists toggles, and never replays a timed-out call", async () => {
  let hangDelete = false;
  let deletes = 0;
  let calls = 0;
  let hang = false;
  let delay = 350;
  let closes = 0;
  let redirect = false;
  let rejectCall = false;
  let loseConnection = false;
  let targetRequests = 0;
  let latestPostResponse: ServerResponse | undefined;
  let notifyCall: (() => void) | undefined;
  const active = new Map<string, StreamableHTTPServerTransport>();
  const server = createServer((request, response) => {
    if (request.url === "/target") {
      targetRequests++;
      response.writeHead(200).end();
      return;
    }
    if (redirect && request.method === "POST") {
      response.writeHead(307, { location: "/target" }).end();
      return;
    }
    const session = request.headers["mcp-session-id"];
    const existing =
      typeof session === "string" ? active.get(session) : undefined;
    if (existing) {
      if (hangDelete && request.method === "DELETE") {
        deletes++;
        return;
      }
      if (request.method === "POST") latestPostResponse = response;
      void existing.handleRequest(request, response);
      return;
    }
    const remote = new McpServer({ name: "remote", version: "1" });
    remote.registerTool("echo", {}, async () => ({ content: [] }));
    remote.server.setRequestHandler(CallToolRequestSchema, async () => {
      calls++;
      notifyCall?.();
      if (loseConnection) {
        latestPostResponse?.destroy();
        await new Promise<void>(() => {});
      }
      if (rejectCall) throw new McpError(ErrorCode.MethodNotFound, "rejected");
      if (hang)
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      return { content: [{ type: "text", text: "http" }] };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => active.set(id, transport),
      onsessionclosed: (id) => {
        closes++;
        active.delete(id);
      },
    });
    void remote
      .connect(transport)
      .then(() => transport.handleRequest(request, response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No loopback address");
  const config = {
    mcpServers: {
      remote: {
        transport: "streamable-http" as const,
        url: `http://127.0.0.1:${address.port}/mcp`,
      },
      legacy: {
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/stdio.mjs", import.meta.url))],
      },
    },
  };
  const saved: unknown[] = [];
  const manager = new McpConnectionManager({
    config,
    clientIdentity: { name: "mixed", version: "1" },
    callTimeoutMs: 200,
    cleanupTimeoutMs: 100,
    persistConfig: (snapshot) => {
      saved.push(snapshot);
    },
  });
  const call = (name: string) =>
    manager.executeToolWithStatus(`mcp__${name}__echo`, {});
  try {
    await manager.initialize();
    expect(manager.listTools()).toHaveLength(2);
    expect((await call("remote")).content).toBe("http");
    expect((await call("legacy")).content).toBe("stdio");
    await manager.setServerEnabled("remote", false);
    expect(active.size).toBe(0);
    expect(closes).toBe(1);
    expect(saved[0]).toEqual({
      mcpServers: {
        ...config.mcpServers,
        remote: { ...config.mcpServers.remote, enabled: false },
      },
    });
    expect((await call("legacy")).status).toBe("success");
    await manager.setServerEnabled("remote", true);
    hang = true;
    const result = await call("remote");
    expect(result.outcome?.completion).toBe("unknown");
    expect(result.outcome?.classification).toBe("timed_out");
    expect(calls).toBe(2);
    expect(active.size).toBe(0);
    expect(closes).toBe(2);
    expect((await call("legacy")).status).toBe("success");
    hang = false;
    await manager.reconnectServer("remote");
    expect((await call("remote")).status).toBe("success");
    expect(calls).toBe(3);
    await manager.reconnectServer("remote");
    expect(closes).toBe(3);
    hang = true;
    delay = 100;
    const started = new Promise<void>((resolve) => {
      notifyCall = resolve;
    });
    const sibling = call("remote");
    await started;
    notifyCall = undefined;
    rejectCall = true;
    // Server-returned JSON-RPC errors must not invalidate concurrent requests.
    const rejection = await call("remote");
    expect(rejection.outcome?.completion).toBe("not_started");
    expect(rejection.content).not.toContain("uncertain");
    rejectCall = false;
    hang = false;
    expect((await sibling).status).toBe("success");
    expect((await call("remote")).status).toBe("success");
    await manager.reconnectServer("remote");
    expect((await call("remote")).status).toBe("success");
    redirect = true;
    expect((await call("remote")).status).toBe("error");
    expect(targetRequests).toBe(0);
    redirect = false;
    await manager.reconnectServer("remote");
    loseConnection = true;
    const beforeLoss = calls;
    expect((await call("remote")).outcome?.completion).toBe("unknown");
    expect(calls).toBe(beforeLoss + 1);
    loseConnection = false;
    await manager.reconnectServer("remote");
    hangDelete = true;
    const cleanupStarted = Date.now();
    await manager.setServerEnabled("remote", false);
    expect(Date.now() - cleanupStarted).toBeLessThan(2_000);
    expect(deletes).toBe(1);
    expect((await call("legacy")).status).toBe("success");
    hangDelete = false;
    // The hung DELETE did not release server-side state; the fixture owns it.
    await Promise.all(
      [...active.values()].map((transport) => transport.close()),
    );
    active.clear();
    await manager.close();
    expect(active.size).toBe(0);

    const directory = mkdtempSync(join(tmpdir(), "mcp-mixed-"));
    const configPath = join(directory, "mcp.json");
    writeFileSync(configPath, JSON.stringify(config));
    const cli = new McpManager({
      configPath,
      credentialStore: new InMemoryMcpCredentialStore(),
    });
    try {
      await cli.initialize();
      await cli.setServerEnabled("remote", false);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        mcpServers: {
          ...config.mcpServers,
          remote: { ...config.mcpServers.remote, enabled: false },
        },
      });
      expect(active.size).toBe(0);
      expect(
        (await cli.executeToolWithStatus("mcp__legacy__echo", {})).status,
      ).toBe("success");
    } finally {
      await cli.close();
      rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    await manager.close();
    await Promise.all(
      [...active.values()].map((transport) => transport.close()),
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([
  { transport: "streamable-http", url: "https://user:marker@example.com/mcp" },
  { transport: "streamable-http", url: "http://example.com/mcp" },
  { transport: "streamable-http", url: "https://example.com", command: "node" },
  { transport: "streamable-http", url: "https://example.com", headers: {} },
  { transport: "streamable-http", url: "https://example.com/mcp?token=marker" },
  { transport: "sse", url: "https://example.com" },
  {
    transport: "streamable-http",
    url: "https://example.com",
    tools: { allow: "bad" },
  },
])("rejects invalid entries without exposing credentials", (entry) => {
  expect(() => validateMcpConfig({ mcpServers: { remote: entry } })).toThrow();
  try {
    validateMcpConfig({ mcpServers: { remote: entry } });
  } catch (error) {
    expect(String(error)).not.toContain("marker");
  }
});
