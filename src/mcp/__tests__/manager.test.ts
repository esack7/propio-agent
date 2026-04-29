import * as fs from "fs";
import * as path from "path";
import { McpManager } from "../manager.js";
import { writeMcpConfig } from "../config.js";

describe("McpManager", () => {
  const tempDir = fs.mkdtempSync(
    path.join(process.cwd(), ".tmp-propio-mcp-manager-"),
  );
  const serverScriptPath = path.join(tempDir, "fake-mcp-server.mjs");
  const configPath = path.join(tempDir, "mcp.json");
  const managers: McpManager[] = [];

  beforeAll(() => {
    fs.writeFileSync(
      serverScriptPath,
      [
        'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
        'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
        'import { z } from "zod";',
        'const server = new McpServer({ name: "fake-server", version: "1.0.0" });',
        'server.registerTool("echo", { description: "Echo tool", inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: "text", text: `echo:${message}` }] }));',
        "await server.connect(new StdioServerTransport());",
      ].join("\n"),
      "utf8",
    );
  });

  afterAll(async () => {
    await Promise.all(managers.map((manager) => manager.close()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("connects to a stdio server and exposes tools", async () => {
    writeMcpConfig(configPath, {
      mcpServers: {
        fake: {
          command: process.execPath,
          args: [serverScriptPath],
          enabled: true,
        },
      },
    });

    const manager = new McpManager({
      configPath,
      clientName: "propio-agent-test",
      clientVersion: "1.0.0",
    });
    managers.push(manager);

    await manager.initialize();

    const summaries = manager.getServerSummaries();
    expect(summaries[0]?.status).toBe("connected");
    expect(manager.listTools("fake").map((tool) => tool.name)).toEqual([
      "mcp__fake__echo",
    ]);

    const execResult = await manager.executeToolWithStatus("mcp__fake__echo", {
      message: "hello",
    });
    expect(execResult.status).toBe("success");
    expect(execResult.content).toContain("echo:hello");
  });

  it("persists enable and disable state", async () => {
    writeMcpConfig(configPath, {
      mcpServers: {
        fake: {
          command: process.execPath,
          args: [serverScriptPath],
          enabled: false,
        },
      },
    });

    const manager = new McpManager({ configPath });
    managers.push(manager);
    await manager.initialize();
    expect(manager.getServerSummaries()[0]?.status).toBe("disabled");

    const enabled = await manager.setServerEnabled("fake", true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.status).toBe("connected");

    const disabled = await manager.setServerEnabled("fake", false);
    expect(disabled.enabled).toBe(false);
    expect(disabled.status).toBe("disabled");
  });

  it("throws when listing tools for an unknown server", async () => {
    const manager = new McpManager({ configPath });
    managers.push(manager);

    await manager.initialize();
    expect(() => manager.listTools("missing")).toThrow(/Unknown MCP server/i);
  });
});
