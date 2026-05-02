import * as fs from "fs";
import * as path from "path";
import { McpManager } from "../manager.js";
import { writeMcpConfig } from "../config.js";

describe("McpManager", () => {
  const tempDir = fs.mkdtempSync(
    path.join(process.cwd(), ".tmp-propio-mcp-manager-"),
  );
  const serverScriptPath = path.join(tempDir, "fake-mcp-server.mjs");
  const connectHangScriptPath = path.join(tempDir, "connect-hang-server.mjs");
  const listHangScriptPath = path.join(tempDir, "list-hang-server.mjs");
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
    fs.writeFileSync(connectHangScriptPath, "setInterval(() => {}, 1000);\n");
    fs.writeFileSync(
      listHangScriptPath,
      [
        'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
        'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
        'import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";',
        'const server = new Server({ name: "list-hang-server", version: "1.0.0" }, { capabilities: { tools: {} } });',
        "server.setRequestHandler(ListToolsRequestSchema, async () => await new Promise(() => {}));",
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

  it("connects using preloaded config", async () => {
    const manager = new McpManager({
      configPath: path.join(tempDir, "preloaded-does-not-need-to-exist.json"),
      config: {
        mcpServers: {
          fake: {
            command: process.execPath,
            args: [serverScriptPath],
            enabled: true,
          },
        },
      },
      clientName: "propio-agent-test",
      clientVersion: "1.0.0",
    });
    managers.push(manager);

    await manager.initialize();

    expect(manager.getServerSummaries()[0]).toMatchObject({
      name: "fake",
      status: "connected",
      toolCount: 1,
    });
  });

  it("times out a server that hangs during connection", async () => {
    const manager = new McpManager({
      config: {
        mcpServers: {
          hanging: {
            command: process.execPath,
            args: [connectHangScriptPath],
            enabled: true,
          },
        },
      },
      connectTimeoutMs: 25,
    });
    managers.push(manager);

    const startedAt = Date.now();
    await manager.initialize();

    const summary = manager.getServerSummaries()[0];
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(summary).toMatchObject({
      name: "hanging",
      status: "failed",
      toolCount: 0,
    });
    expect(summary?.lastError).toMatch(/Timed out after 25ms/i);
  });

  it("times out a server that hangs while listing tools", async () => {
    const manager = new McpManager({
      config: {
        mcpServers: {
          listHang: {
            command: process.execPath,
            args: [listHangScriptPath],
            enabled: true,
          },
        },
      },
      connectTimeoutMs: 25,
    });
    managers.push(manager);

    await manager.initialize();

    const summary = manager.getServerSummaries()[0];
    expect(summary).toMatchObject({
      name: "listHang",
      status: "failed",
      toolCount: 0,
    });
    expect(summary?.lastError).toMatch(/Timed out after 25ms/i);
  });

  it("continues startup when one server times out", async () => {
    const manager = new McpManager({
      config: {
        mcpServers: {
          fake: {
            command: process.execPath,
            args: [serverScriptPath],
            enabled: true,
          },
          hanging: {
            command: process.execPath,
            args: [connectHangScriptPath],
            enabled: true,
          },
        },
      },
      connectTimeoutMs: 2000,
      clientName: "propio-agent-test",
      clientVersion: "1.0.0",
    });
    managers.push(manager);

    await manager.initialize();

    const summaries = new Map(
      manager.getServerSummaries().map((summary) => [summary.name, summary]),
    );
    expect(summaries.get("fake")).toMatchObject({
      status: "connected",
      toolCount: 1,
    });
    expect(summaries.get("hanging")).toMatchObject({
      status: "failed",
      toolCount: 0,
    });
  });

  it("does not block cleanup after a startup timeout", async () => {
    const manager = new McpManager({
      config: {
        mcpServers: {
          hanging: {
            command: process.execPath,
            args: [connectHangScriptPath],
            enabled: true,
          },
        },
      },
      connectTimeoutMs: 25,
    });
    managers.push(manager);

    await manager.initialize();
    const startedAt = Date.now();
    await manager.close();

    expect(Date.now() - startedAt).toBeLessThan(1000);
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
