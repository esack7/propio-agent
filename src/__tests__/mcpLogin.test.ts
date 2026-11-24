import { createAbortStateController } from "../ui/abortState.js";
import { request } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMcpCredentialStore } from "../config/mcpCredentialStore.js";
import { McpManager } from "../mcp/manager.js";
import { handleMcpCommand } from "../ui/mcpMenu.js";
import { oauthFixture } from "../mcp/__tests__/fixtures/oauth.js";
import { withMcpLogin } from "../mcp/login.js";

test("callback binds state and closes after success", async () => {
  let redirect = "";
  await withMcpLogin(
    async (interaction, signal) => {
      redirect = interaction.redirectUrl;
      const url = new URL("http://127.0.0.1/authorize?state=expected");
      await expect(interaction.authorize(url, signal)).resolves.toEqual({
        code: "synthetic-code",
        state: "expected",
      });
    },
    async () => {
      const endpoint = new URL(redirect);
      await new Promise<void>((resolve, reject) => {
        const malformed = request(
          { hostname: endpoint.hostname, port: endpoint.port, path: "//" },
          (response) => {
            expect(response.statusCode).toBe(400);
            response.resume();
            response.on("end", resolve);
          },
        );
        malformed.on("error", reject);
        malformed.end();
      });
      expect((await fetch(`${redirect}?state=wrong&code=bad`)).status).toBe(
        400,
      );
      await fetch(`${redirect}?state=expected&code=synthetic-code`);
    },
  );
  await expect(fetch(redirect)).rejects.toThrow();
});

test("cancelled login releases callback", async () => {
  const controller = new AbortController();
  let redirect = "";
  await expect(
    withMcpLogin(
      async (interaction, signal) => {
        redirect = interaction.redirectUrl;
        return interaction.authorize(
          new URL("http://127.0.0.1/authorize?state=expected"),
          signal,
        );
      },
      async () => {
        controller.abort();
      },
      controller.signal,
    ),
  ).rejects.toThrow("cancelled");
  await expect(fetch(redirect)).rejects.toThrow();
});

test("manager cancellation interrupts a stuck browser and releases listener", async () => {
  let redirect = "";
  const controller = new AbortController();
  await expect(
    withMcpLogin(
      async (interaction) => {
        redirect = interaction.redirectUrl;
        return interaction.authorize(
          new URL("http://127.0.0.1/authorize?state=x"),
          controller.signal,
        );
      },
      async () => {
        controller.abort();
        return new Promise<void>(() => {});
      },
    ),
  ).rejects.toThrow("cancelled");
  await expect(fetch(redirect)).rejects.toThrow();
});

// Exercise the same adapter and command handlers used by the interactive CLI.
test("CLI login survives restart, refreshes, and logout rejects a late refresh", async () => {
  const local = await oauthFixture();
  const home = await mkdtemp(join(tmpdir(), "mcp-cli-"));
  const configPath = join(home, "mcp.json");
  const directory = join(home, "mcp-auth");
  const config = {
    mcpServers: {
      docs: {
        transport: "streamable-http" as const,
        url: `${local.origin}/mcp`,
      },
    },
  };
  await writeFile(configPath, JSON.stringify(config));
  const messages: string[] = [];
  const ui = {
    command: (text: string) => messages.push(text),
    success: (text: string) => messages.push(text),
    error: (text: string) => messages.push(text),
  };
  let browsers = 0;
  const options = {
    configPath,
    credentialStore: new FileMcpCredentialStore(directory),
    openBrowser: async (address: string) => {
      browsers++;
      const url = new URL(address);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", "synthetic-code");
      await fetch(callback);
    },
  };
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  let manager = new McpManager(options);
  const command = (input: string) =>
    handleMcpCommand(
      input,
      {
        loginMcpServer: (name: string) => manager.loginCliServer(name),
        logoutMcpServer: (name: string) => manager.clearServerCredentials(name),
      } as never,
      ui as never,
    );
  try {
    await manager.initialize();
    expect(manager.getServerSummaries()[0].lastError).toContain(
      "authorization required",
    );
    await command("/mcp login docs");
    expect(messages).toContain("MCP sign-in completed");
    await manager.close();
    local.tokens.clear();
    manager = new McpManager(options);
    await manager.initialize();
    expect(manager.getServerSummaries()[0].status).toBe("connected");
    expect(local.refreshes()).toBe(1);
    expect(browsers).toBe(1);
    // A second explicit login has a fresh callback port and registration.
    await command("/mcp login docs");
    expect(browsers).toBe(2);
    local.tokens.clear();
    const started = local.pause();
    const reconnect = manager.reconnectServer("docs");
    await started;
    await command("/mcp logout docs");
    local.resume();
    await reconnect;
    const record = await options.credentialStore.load({
      owner: "local",
      serverName: "docs",
      resource: config.mcpServers.docs.url,
    });
    expect(record.tokens).toBeUndefined();
    expect(await readFile(configPath, "utf8")).not.toContain("synthetic-code");
    expect(messages.join("\n")).not.toContain("synthetic-code");
  } finally {
    local.resume();
    await manager.close();
    await local.close();
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    await rm(home, { recursive: true, force: true });
  }
}, 20_000);

test.each(["SIGINT", "close", "timeout"])(
  "CLI %s bounds login and closes the callback",
  async (reason) => {
    const local = await oauthFixture();
    const directory = await mkdtemp(join(tmpdir(), "mcp-cancel-"));
    let redirect = "";
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const manager = new McpManager({
      config: {
        mcpServers: {
          docs: { transport: "streamable-http", url: `${local.origin}/mcp` },
        },
      },
      credentialStore: new FileMcpCredentialStore(directory),
      loginTimeoutMs: reason === "timeout" ? 500 : 5_000,
      openBrowser: async (address) => {
        redirect = new URL(address).searchParams.get("redirect_uri")!;
        if (reason === "SIGINT") process.emit("SIGINT");
        if (reason === "close") void manager.close();
        return new Promise<void>(() => {});
      },
    });
    const abortState = createAbortStateController({
      setMode() {},
      warn() {},
    } as never);
    process.on("SIGINT", abortState.handleSigint);
    try {
      await expect(manager.loginCliServer("docs")).rejects.toThrow(
        "cancelled or timed out",
      );
      expect(abortState.shouldExit()).toBe(false);
      expect(redirect).not.toBe("");
      await expect(fetch(redirect)).rejects.toThrow();
    } finally {
      process.off("SIGINT", abortState.handleSigint);
      await manager.close();
      await local.close();
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("CLI errors are actionable for unknown, stdio and noninteractive login", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-status-"));
  const manager = new McpManager({
    config: {
      mcpServers: {
        docs: { transport: "streamable-http", url: "http://127.0.0.1:1/mcp" },
        legacy: { command: "unused" },
      },
    },
    credentialStore: new FileMcpCredentialStore(directory),
  });
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: false,
  });
  try {
    for (const [name, expected] of [
      ["missing", "Unknown MCP server"],
      ["legacy", "Streamable HTTP"],
      ["docs", "interactive terminal"],
    ]) {
      const messages: string[] = [];
      const emit = (text: string) => messages.push(text);
      await handleMcpCommand(
        `/mcp login ${name}`,
        {
          loginMcpServer: (server: string) => manager.loginCliServer(server),
        } as never,
        { error: emit, command: emit, success: emit } as never,
      );
      expect(messages.join("\n")).toContain(expected);
    }
  } finally {
    await manager.close();
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    await rm(directory, { recursive: true, force: true });
  }
});
