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
});
