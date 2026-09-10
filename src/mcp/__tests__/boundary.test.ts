import * as fs from "node:fs";
import * as path from "node:path";
import {
  McpConnectionManager,
  validateMcpConfig,
  buildMcpToolName,
} from "../index.js";
import type { McpConnectionOptions, McpConfigFile } from "../index.js";

const identity = { name: "standalone-consumer", version: "2.3.4" };
const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-mcp-boundary-"));
const script = path.join(tempDir, "server.mjs");
const managers: McpConnectionManager[] = [];
let sequence = 0;

beforeAll(() => {
  fs.writeFileSync(
    script,
    `
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const [mode, pidFile, readyFile] = process.argv.slice(2);
fs.writeFileSync(pidFile, String(process.pid));
if (mode === "connect-hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} }, instructions: "Fixture instructions" });
  const tool = (name) => ({ name, description: "Fixture tool", inputSchema: { type: "object", additionalProperties: false } });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    fs.writeFileSync(readyFile, "listing");
    if (mode === "list-hang") return await new Promise(() => {});
    if (mode === "collision") return { tools: [tool("a-b"), tool("a_b")] };
    if (mode === "duplicate") {
      if (!request.params?.cursor) return { tools: [tool("same"), tool("same")], nextCursor: "overlap" };
      return { tools: [{ ...tool("same"), description: "Later duplicate" }] };
    }
    if (!request.params?.cursor) return { tools: [tool("echo")], nextCursor: "second" };
    return { tools: [tool("result")] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    if (args.hang) return await new Promise(() => {});
    if (args.throw) throw new Error("fixture failure");
    if (args.result) return args.result;
    return { content: [{ type: "text", text: JSON.stringify({ args, identity: server.getClientVersion() }) }] };
  });
  await server.connect(new StdioServerTransport());
}
`,
  );
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function fixture(mode = "normal", options: Partial<McpConnectionOptions> = {}) {
  const prefix = path.join(tempDir, String(sequence++));
  const pidFile = `${prefix}.pid`;
  const readyFile = `${prefix}.ready`;
  const config: McpConfigFile = {
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [script, mode, pidFile, readyFile],
      },
    },
  };
  const manager = new McpConnectionManager({
    config,
    clientIdentity: identity,
    ...options,
  });
  managers.push(manager);
  return { manager, pidFile, readyFile, config };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("Fixture did not reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file: string): number {
  return Number(fs.readFileSync(file, "utf8"));
}

it("discovers all pages, preserves schemas and sends the supplied identity", async () => {
  const { manager } = fixture();
  await manager.initialize();
  expect(manager.listTools().map((tool) => tool.name)).toEqual([
    "mcp__fixture__echo",
    "mcp__fixture__result",
  ]);
  expect(manager.listTools()[0]?.inputSchema.additionalProperties).toBe(false);
  expect(manager.getServerDetail("fixture")?.instructions).toBe(
    "Fixture instructions",
  );
  const result = await manager.executeToolWithStatus("mcp__fixture__echo", {
    message: "hi",
  });
  expect(result.status).toBe("success");
  expect(JSON.parse(result.content)).toEqual({
    args: { message: "hi" },
    identity,
  });
  expect(manager.hasTool("mcp__fixture__echo")).toBe(true);
  expect(await manager.executeToolWithStatus("missing", {})).toMatchObject({
    status: "tool_not_found",
  });
});

it("supports in-memory enable/disable and reconnect without a configuration file", async () => {
  const { manager, pidFile } = fixture();
  await manager.initialize();
  const first = readPid(pidFile);
  expect((await manager.reconnectServer("fixture")).status).toBe("connected");
  expect(isAlive(first)).toBe(false);
  expect(readPid(pidFile)).not.toBe(first);
  expect((await manager.setServerEnabled("fixture", false)).status).toBe(
    "disabled",
  );
  expect(manager.listTools()).toEqual([]);
  expect((await manager.setServerEnabled("fixture", true)).status).toBe(
    "connected",
  );
});

it("awaits persistence, isolates snapshots and leaves state intact on persistence failure", async () => {
  let reject = true;
  const snapshots: McpConfigFile[] = [];
  const { manager } = fixture("normal", {
    persistConfig: async (config) => {
      await Promise.resolve();
      if (reject) throw new Error("storage unavailable");
      snapshots.push(config);
      config.mcpServers!.fixture.args!.push("caller mutation");
    },
  });
  await manager.initialize();
  await expect(manager.setServerEnabled("fixture", false)).rejects.toThrow(
    "storage unavailable",
  );
  expect(manager.getServerSummaries()[0]?.status).toBe("connected");
  reject = false;
  await manager.setServerEnabled("fixture", false);
  expect(snapshots[0]?.mcpServers?.fixture.enabled).toBe(false);
  expect(manager.getServerDetail("fixture")?.args).not.toContain(
    "caller mutation",
  );
});

it("serializes concurrent persistence changes", async () => {
  const snapshots: boolean[] = [];
  const { manager } = fixture("normal", {
    persistConfig: async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapshots.push(config.mcpServers!.fixture.enabled!);
    },
  });
  await Promise.all([
    manager.setServerEnabled("fixture", false),
    manager.setServerEnabled("fixture", true),
  ]);
  expect(snapshots).toEqual([false, true]);
  expect(manager.getServerSummaries()[0]?.status).toBe("connected");
});

it.each(["connect-hang", "list-hang"])(
  "kills a child that times out during %s",
  async (mode) => {
    const { manager, pidFile, readyFile } = fixture(mode, {
      connectTimeoutMs: 1000,
      cleanupTimeoutMs: 100,
    });
    const starting = manager.initialize();
    await waitFor(() =>
      fs.existsSync(mode === "list-hang" ? readyFile : pidFile),
    );
    const pid = readPid(pidFile);
    await starting;
    expect(manager.getServerSummaries()[0]).toMatchObject({
      status: "failed",
      toolCount: 0,
    });
    expect(manager.getServerSummaries()[0]?.lastError).toContain(
      "Timed out after 1000ms",
    );
    await waitFor(() => !isAlive(pid));
  },
);

it.each(["collision"])(
  "rejects %s tool names and cleans up the server",
  async (mode) => {
    const { manager, pidFile } = fixture(mode);
    await manager.initialize();
    expect(manager.getServerSummaries()[0]?.lastError).toContain(
      "normalize to the same name",
    );
    expect(manager.listTools()).toEqual([]);
    await waitFor(() => !isAlive(readPid(pidFile)));
  },
);

it("closes a pending connection and prevents later resurrection", async () => {
  const { manager, pidFile } = fixture("connect-hang", {
    cleanupTimeoutMs: 100,
  });
  const starting = manager.initialize();
  await waitFor(() => fs.existsSync(pidFile));
  const pid = readPid(pidFile);
  await Promise.all([manager.close(), starting]);
  await waitFor(() => !isAlive(pid));
  expect(manager.getServerSummaries()[0]?.status).toBe("disabled");
  await expect(manager.initialize()).rejects.toThrow("closed");
  await expect(manager.reconnectServer("fixture")).rejects.toThrow("closed");
});

it("handles unexpected exit and reconnects", async () => {
  const { manager, pidFile } = fixture();
  await manager.initialize();
  process.kill(readPid(pidFile), "SIGKILL");
  await waitFor(() => manager.getServerSummaries()[0]?.status === "failed");
  expect(manager.listTools()).toEqual([]);
  expect((await manager.reconnectServer("fixture")).status).toBe("connected");
});

it("applies the supplied tool-call deadline and recovers for subsequent calls", async () => {
  const { manager } = fixture("normal", { callTimeoutMs: 50 });
  await manager.initialize();
  expect(
    await manager.executeToolWithStatus("mcp__fixture__echo", { hang: true }),
  ).toMatchObject({
    status: "error",
    content: expect.stringMatching(/timed out/i),
  });
  expect(
    (await manager.executeToolWithStatus("mcp__fixture__echo", {})).status,
  ).toBe("success");
});

it.each([
  [{ content: [] }, "success", "Tool completed successfully."],
  [
    { content: [{ type: "text", text: " failure " }], isError: true },
    "error",
    "Error executing mcp__fixture__result: failure",
  ],
  [
    { content: [], isError: true },
    "error",
    "Error executing mcp__fixture__result: The MCP server reported an error without details.",
  ],
  [
    {
      content: [
        { type: "image", mimeType: "image/png", data: "YWJj" },
        { type: "audio", mimeType: "audio/wav", data: "YWJj" },
        {
          type: "resource",
          resource: { uri: "test://text", text: "embedded text" },
        },
        { type: "resource", resource: { uri: "test://blob", blob: "YWJj" } },
        { type: "resource_link", uri: "test://link", name: "link" },
      ],
      structuredContent: { ok: true },
    },
    "success",
    '[image image/png, 4 base64 chars]\n\n[audio audio/wav, 4 base64 chars]\n\nembedded text\n\n[resource test://blob]\n\n[resource test://link]\n\n{\n  "ok": true\n}',
  ],
])(
  "retains the text result representation %#",
  async (result, status, content) => {
    const { manager } = fixture();
    await manager.initialize();
    expect(
      await manager.executeToolWithStatus("mcp__fixture__result", { result }),
    ).toEqual({ status, content });
  },
);

it("reports remote request errors", async () => {
  const { manager } = fixture();
  await manager.initialize();
  expect(
    await manager.executeToolWithStatus("mcp__fixture__echo", { throw: true }),
  ).toMatchObject({
    status: "error",
    content: expect.stringContaining("fixture failure"),
  });
});

it("validates supplied configuration and stable names without scanning", () => {
  expect(validateMcpConfig({})).toEqual({ mcpServers: {} });
  expect(() =>
    fixture("normal", {
      config: {
        mcpServers: { "a-b": { command: "node" }, a_b: { command: "node" } },
      },
    }),
  ).toThrow("normalize to the same identifier");
  expect(() =>
    validateMcpConfig({
      mcpServers: { web: { command: "node", url: "https://example.com" } },
    }),
  ).toThrow("Only stdio");
  expect(buildMcpToolName("My Server", "My Tool")).toBe(
    "mcp__my_server__my_tool",
  );
});

it.each([0, -1, NaN, Infinity, 2 ** 31])(
  "rejects invalid timeout %s",
  (connectTimeoutMs) => {
    expect(() => fixture("normal", { connectTimeoutMs })).toThrow("timeouts");
  },
);

it("disables a pending connection and cleans up its child", async () => {
  const { manager, pidFile } = fixture("connect-hang", {
    cleanupTimeoutMs: 100,
  });
  const starting = manager.initialize();
  await waitFor(() => fs.existsSync(pidFile));
  const pid = readPid(pidFile);
  await manager.setServerEnabled("fixture", false);
  await starting;
  await waitFor(() => !isAlive(pid));
  expect(manager.getServerSummaries()[0]?.status).toBe("disabled");
});

it("shares shutdown work across concurrent closes", async () => {
  const { manager, pidFile } = fixture("connect-hang", {
    cleanupTimeoutMs: 100,
  });
  const starting = manager.initialize();
  await waitFor(() => fs.existsSync(pidFile));
  const first = manager.close();
  expect(manager.close()).toBe(first);
  await Promise.all([first, starting]);
  expect(isAlive(readPid(pidFile))).toBe(false);
});

it("isolates caller configuration and returned tool schemas", async () => {
  const { manager, config } = fixture();
  config.mcpServers!.fixture.args!.push("caller mutation");
  expect(manager.getServerDetail("fixture")?.args).not.toContain(
    "caller mutation",
  );
  await manager.initialize();
  manager.listTools()[0]!.inputSchema.additionalProperties = true;
  expect(manager.listTools()[0]!.inputSchema.additionalProperties).toBe(false);
});

it("handles prototype-like server identifiers as ordinary own keys", async () => {
  const config = validateMcpConfig(
    JSON.parse(
      '{"mcpServers":{"__proto__":{"command":"node","enabled":false}}}',
    ),
  );
  const { manager } = fixture("normal", { config });
  await manager.initialize();
  expect(manager.getServerSummaries()).toEqual([
    { name: "__proto__", enabled: false, status: "disabled", toolCount: 0 },
  ]);
  expect((await manager.setServerEnabled("__proto__", false)).status).toBe(
    "disabled",
  );
  await expect(manager.reconnectServer("constructor")).rejects.toThrow(
    "Unknown MCP server",
  );
});

it("deduplicates identical remote names within and across discovery pages", async () => {
  const { manager } = fixture("duplicate");
  await manager.initialize();
  expect(manager.getServerSummaries()[0]?.status).toBe("connected");
  expect(manager.listTools().map((tool) => tool.remoteToolName)).toEqual([
    "same",
  ]);
  expect(manager.listTools()[0]?.description).toBe("Fixture tool");
});

it("resolves a successful persistence write when shutdown occurs during it", async () => {
  let finish!: () => void;
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const persisted: McpConfigFile[] = [];
  const { manager } = fixture("normal", {
    persistConfig: async (config) => {
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      persisted.push(config);
    },
  });
  const changing = manager.setServerEnabled("fixture", true);
  await writing;
  await manager.close();
  finish();
  await expect(changing).resolves.toMatchObject({
    status: "disabled",
    enabled: false,
  });
  expect(persisted[0]?.mcpServers?.fixture.enabled).toBe(true);
  expect(manager.listTools()).toEqual([]);
});
