import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getMcpConfigPath,
  isMcpServerEnabled,
  loadMcpConfig,
  loadMcpConfigAsync,
  updateMcpServerEnabledInFile,
  validateMcpConfig,
  writeMcpConfig,
} from "../config.js";

describe("mcp config", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-mcp-config-"));

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the home config path when no docker config is present", () => {
    expect(getMcpConfigPath()).toContain(path.join(".propio", "mcp.json"));
  });

  it("loads a missing file as an empty MCP config", () => {
    expect(loadMcpConfig(path.join(tempDir, "missing.json"))).toEqual({
      mcpServers: {},
    });
  });

  it("loads a missing file as an empty MCP config asynchronously", async () => {
    await expect(
      loadMcpConfigAsync(path.join(tempDir, "missing-async.json")),
    ).resolves.toEqual({
      mcpServers: {},
    });
  });

  it("loads a valid MCP config asynchronously", async () => {
    const filePath = path.join(tempDir, "async-mcp.json");
    writeMcpConfig(filePath, {
      mcpServers: {
        fake: {
          command: "node",
          args: ["server.mjs"],
        },
      },
    });

    await expect(loadMcpConfigAsync(filePath)).resolves.toEqual({
      mcpServers: {
        fake: {
          command: "node",
          args: ["server.mjs"],
        },
      },
    });
  });

  it("accepts stdio-only config and defaults enabled to true", () => {
    const config = validateMcpConfig({
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["@playwright/mcp@latest"],
        },
      },
    });

    expect(config.mcpServers?.playwright?.command).toBe("npx");
    expect(isMcpServerEnabled(config.mcpServers!.playwright)).toBe(true);
  });

  it("rejects unsupported transports with a v1 error", () => {
    expect(() =>
      validateMcpConfig({
        mcpServers: {
          remote: {
            url: "https://example.com/mcp",
          },
        },
      }),
    ).toThrow(/not yet supported in v1/i);
  });

  it("writes and updates the config atomically", () => {
    const filePath = path.join(tempDir, "mcp.json");
    writeMcpConfig(filePath, {
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["@playwright/mcp@latest"],
          enabled: true,
        },
      },
    });

    const updated = updateMcpServerEnabledInFile(filePath, "playwright", false);
    expect(updated.mcpServers?.playwright?.enabled).toBe(false);
    expect(loadMcpConfig(filePath).mcpServers?.playwright?.enabled).toBe(false);
  });
});
