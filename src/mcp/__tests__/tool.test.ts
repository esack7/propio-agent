import { McpExecutableTool } from "../tool.js";

describe("McpExecutableTool", () => {
  it("preserves the full remote JSON schema on the exposed tool", () => {
    const tool = new McpExecutableTool({
      serverName: "playwright",
      remoteTool: {
        name: "navigate",
        description: "Navigate the browser",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
          additionalProperties: false,
          oneOf: [{ type: "object" }],
        },
      } as never,
      invoke: async () => ({ status: "success", content: "ok" }),
    });

    expect(tool.getSchema().function.parameters.additionalProperties).toBe(
      false,
    );
    expect(tool.getSchema().function.parameters.oneOf).toEqual([
      { type: "object" },
    ]);
    expect(tool.getSchema().function.parameters.required).toEqual(["url"]);
  });
});
