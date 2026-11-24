import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpConnectionManager } from "../connectionManager.js";
import { validateMcpConfig } from "../validation.js";

it("lists and calls mixed transports, persists toggles, and never replays a timed-out call", async () => {
  let calls = 0;
  let hang = false;
  const remote = new McpServer({ name: "remote", version: "1" });
  remote.registerTool("echo", {}, async () => {
    calls++;
    if (hang) await new Promise<void>(() => {});
    return { content: [{ type: "text", text: "http" }] };
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await remote.connect(transport);
  const server = createServer((request, response) => {
    void transport.handleRequest(request, response);
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
        url: `http://127.0.0.1:${address.port}/mcp?secret=marker`,
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
    expect(JSON.stringify(manager.getServerDetail("remote"))).not.toContain(
      "marker",
    );
    await manager.setServerEnabled("remote", false);
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
    expect(result.content).not.toContain("marker");
    expect(calls).toBe(2);
    expect((await call("legacy")).status).toBe("success");
    hang = false;
    await manager.reconnectServer("remote");
    expect((await call("remote")).status).toBe("success");
    expect(calls).toBe(3);
  } finally {
    await manager.close();
    await remote.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([
  { transport: "streamable-http", url: "https://user:marker@example.com/mcp" },
  { transport: "streamable-http", url: "http://example.com/mcp" },
  { transport: "streamable-http", url: "https://example.com", command: "node" },
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
