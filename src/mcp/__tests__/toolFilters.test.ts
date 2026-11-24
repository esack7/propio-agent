import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpExecutableTool } from "../tool.js";
import { McpManager } from "../manager.js";
import { validateMcpConfig } from "../validation.js";
import { loadMcpConfig, updateMcpServerEnabledInFile } from "../config.js";
import {
  createTestAgent,
  ToolCallMockProvider,
  userSubmission,
} from "../../__tests__/testHelpers.js";

async function fixture() {
  const calls: string[] = [];
  let names = ["search", "lookup", "searchExtra"];
  const transports: StreamableHTTPServerTransport[] = [];
  const server = createServer((request, response) => {
    const remote = new McpServer({ name: "counted", version: "1" });
    for (const name of names)
      remote.registerTool(name, {}, async () => {
        calls.push(request.url + ":" + name);
        return { content: [{ type: "text", text: "done" }] };
      });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    transports.push(transport);
    void remote
      .connect(transport)
      .then(() => transport.handleRequest(request, response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return {
    calls,
    url: `http://127.0.0.1:${address.port}`,
    setNames: (value: string[]) => {
      names = value;
    },
    close: async () => {
      await Promise.all(transports.map((transport) => transport.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it.each([
  null,
  [],
  "search",
  { allow: "search" },
  { deny: [1] },
  { allow: [""] },
  { other: [] },
])("rejects malformed filters %j on both transports", (tools) => {
  for (const entry of [
    { command: "node" },
    { transport: "streamable-http", url: "https://example.com" },
  ]) {
    expect(() =>
      validateMcpConfig({ mcpServers: { docs: { ...entry, tools } } }),
    ).toThrow(/tools/);
  }
});

it("preserves filters through mixed-file toggles", () => {
  const root = mkdtempSync(join(tmpdir(), "filters-"));
  const file = join(root, "mcp.json");
  const config = {
    mcpServers: {
      docs: {
        transport: "streamable-http",
        url: "https://example.com",
        tools: { allow: [], deny: ["lookup"] },
      },
      legacy: { command: "node", tools: { allow: ["search"], deny: [] } },
    },
  };
  try {
    writeFileSync(file, JSON.stringify(config));
    for (const name of ["docs", "legacy"]) {
      updateMcpServerEnabledInFile(file, name, false);
      updateMcpServerEnabledInFile(file, name, true);
    }
    for (const name of ["docs", "legacy"] as const)
      expect(loadMcpConfig(file).mcpServers?.[name].tools).toEqual(
        config.mcpServers[name].tools,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("filters discovery and stale handles across disable and reconnect", async () => {
  const remote = await fixture();
  const root = mkdtempSync(join(tmpdir(), "filters-"));
  const config = {
    mcpServers: {
      docs: {
        transport: "streamable-http" as const,
        url: remote.url,
        tools: { allow: ["search", "lookup"], deny: ["lookup"] },
      },
    },
  };
  const configPath = join(root, "mcp.json");
  writeFileSync(configPath, JSON.stringify(config));
  const manager = new McpManager({ config, configPath });
  try {
    await manager.initialize();
    expect(manager.listTools().map((tool) => tool.remoteToolName)).toEqual([
      "search",
    ]);
    const descriptor = manager.listTools()[0];
    const adapter = new McpExecutableTool({
      serverName: "docs",
      remoteTool: {
        name: descriptor.remoteToolName,
        inputSchema: descriptor.inputSchema,
      },
      invoke: (args) => manager.executeToolWithStatus(descriptor.name, args),
    });
    const stale = () => adapter.executeWithStatus({});
    expect(
      (await manager.executeToolWithStatus("mcp__docs__lookup", {})).status,
    ).toBe("tool_not_found");
    await manager.setServerEnabled("docs", false);
    expect((await stale()).status).not.toBe("success");
    remote.setNames(["lookup"]);
    await manager.setServerEnabled("docs", true);
    expect(manager.listTools()).toEqual([]);
    expect((await stale()).status).not.toBe("success");
    expect(remote.calls).toEqual([]);
  } finally {
    await manager.close();
    await remote.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("dispatches only approved selected calls through agent permissions", async () => {
  const remote = await fixture();
  try {
    for (const mode of [
      "filtered",
      "unapproved",
      "rule-denied",
      "denied",
      "approved",
    ] as const) {
      const tool = mode === "filtered" ? "lookup" : "search";
      const provider = new ToolCallMockProvider(`mcp__docs__${tool}`);
      const decisions: unknown[] = [];
      const agent = createTestAgent(provider, {
        mcpConfig: {
          mcpServers: {
            docs: {
              transport: "streamable-http",
              url: remote.url + "/docs",
              tools: { deny: ["lookup", "searchExtra"] },
            },
            other: {
              transport: "streamable-http",
              url: remote.url + "/other",
              tools: { allow: ["search"] },
            },
          },
        },
        permissions:
          mode === "unapproved"
            ? undefined
            : {
                approvalChannel: {
                  request: async (request) => {
                    decisions.push(request.target);
                    return {
                      requestId: request.id,
                      decision: mode === "approved" ? "allow_once" : "deny",
                    };
                  },
                },
              },
      });
      try {
        await agent.initialize();
        if (mode === "rule-denied")
          await agent.permissions.addRule("deny", "mcp__docs");
        await agent.streamChat(userSubmission("Use the tool"), () => {});
        expect(decisions).toHaveLength(
          mode === "denied" || mode === "approved" ? 1 : 0,
        );
        if (mode === "approved")
          expect(decisions[0]).toMatchObject({
            kind: "mcp",
            serverPrefix: "mcp__docs",
          });
        expect(remote.calls).toEqual(
          mode === "approved" ? ["/docs:search"] : [],
        );
      } finally {
        await agent.close();
      }
    }
  } finally {
    await remote.close();
  }
});
