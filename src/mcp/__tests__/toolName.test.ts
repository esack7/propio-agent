import { buildMcpToolName, normalizeMcpNameSegment } from "../toolName.js";

describe("mcp toolName", () => {
  it("normalizes names deterministically", () => {
    expect(normalizeMcpNameSegment("Playwright MCP")).toBe("playwright_mcp");
    expect(normalizeMcpNameSegment("  weird---Name!! ")).toBe("weird_name");
    expect(normalizeMcpNameSegment("")).toBe("unnamed");
  });

  it("builds fully qualified tool names", () => {
    expect(buildMcpToolName("Playwright MCP", "browser.navigate")).toBe(
      "mcp__playwright_mcp__browser_navigate",
    );
  });

  it("bounds very long tool names while staying stable", () => {
    const longServer = "server".repeat(20);
    const longTool = "tool".repeat(20);
    const first = buildMcpToolName(longServer, longTool);
    const second = buildMcpToolName(longServer, `${longTool}x`);

    expect(first.length).toBeLessThanOrEqual(64);
    expect(second.length).toBeLessThanOrEqual(64);
    expect(first).not.toBe(second);
    expect(first.startsWith("mcp__")).toBe(true);
  });
});
