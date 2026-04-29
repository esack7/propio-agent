import { handleMcpCommand } from "../mcpMenu.js";

describe("mcpMenu", () => {
  it("reports reconnect failures as errors", async () => {
    const messages: string[] = [];
    const agent = {
      getMcpServerSummaries: () => [],
      getMcpServerDetail: () => null,
      listMcpTools: jest.fn(),
      reconnectMcpServer: async () => ({
        name: "playwright",
        enabled: true,
        status: "failed",
        toolCount: 0,
        lastError: "could not connect",
      }),
      setMcpServerEnabled: jest.fn(),
    };

    const ui = createUi(messages);
    await handleMcpCommand("/mcp reconnect playwright", agent as never, ui);

    expect(messages.join("\n")).toContain(
      "Reconnected playwright but it is still failed",
    );
  });

  it("reports unknown MCP servers as errors for /mcp tools", async () => {
    const messages: string[] = [];
    const agent = {
      getMcpServerSummaries: () => [],
      getMcpServerDetail: () => null,
      listMcpTools: () => {
        throw new Error('Unknown MCP server: "typo"');
      },
      reconnectMcpServer: jest.fn(),
      setMcpServerEnabled: jest.fn(),
    };

    const ui = createUi(messages);
    await handleMcpCommand("/mcp tools typo", agent as never, ui);

    expect(messages.join("\n")).toContain('Unknown MCP server: "typo"');
  });

  it("accepts MCP server names with spaces", async () => {
    const messages: string[] = [];
    const listMcpTools = jest.fn().mockReturnValue([
      {
        name: "mcp__playwright_mcp__echo",
        description: "Echo",
        serverName: "Playwright MCP",
        remoteToolName: "echo",
      },
    ]);
    const agent = {
      getMcpServerSummaries: () => [],
      getMcpServerDetail: (name: string) =>
        name === "Playwright MCP"
          ? {
              name,
              enabled: true,
              status: "connected",
              command: "npx",
              args: [],
              envKeys: [],
              tools: [],
            }
          : null,
      listMcpTools,
      reconnectMcpServer: jest.fn(),
      setMcpServerEnabled: jest.fn(),
    };

    const ui = createUi(messages);
    await handleMcpCommand("/mcp get Playwright MCP", agent as never, ui);

    expect(listMcpTools).not.toHaveBeenCalled();
    expect(messages.join("\n")).toContain("Playwright MCP");
  });

  it("reports enable failures when a server remains unhealthy", async () => {
    const messages: string[] = [];
    const agent = {
      getMcpServerSummaries: () => [],
      getMcpServerDetail: () => null,
      listMcpTools: jest.fn(),
      reconnectMcpServer: jest.fn(),
      setMcpServerEnabled: async () => ({
        name: "playwright",
        enabled: true,
        status: "failed",
        toolCount: 0,
        lastError: "could not connect",
      }),
    };

    const ui = createUi(messages);
    await handleMcpCommand("/mcp enable playwright", agent as never, ui);

    expect(messages.join("\n")).toContain(
      "Enabled playwright but it is still failed",
    );
  });
});

function createUi(messages: string[]) {
  return {
    command: (text: string) => messages.push(text),
    error: (text: string) => messages.push(text),
    info: (text: string) => messages.push(text),
    section: (text: string) => messages.push(text),
    success: (text: string) => messages.push(text),
  };
}
