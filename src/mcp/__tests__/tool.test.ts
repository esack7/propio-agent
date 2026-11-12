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

  it("uses the supplied argument check", () => {
    const tool = new McpExecutableTool({
      serverName: "fixture",
      remoteTool: { name: "echo", inputSchema: { type: "object" } },
      invoke: async () => ({ status: "success", content: "ok" }),
      validateArguments: (args) =>
        args.ok
          ? undefined
          : { status: "invalid_arguments", content: "manager says no" },
    });

    expect(tool.validateArguments({ ok: true })).toBeUndefined();
    expect(tool.validateArguments({})).toEqual({
      status: "invalid_arguments",
      content: "manager says no",
    });
  });

  it("keeps the registry's schema check when no argument check is supplied", async () => {
    const { ToolRegistry } = await import("../../tools/index.js");
    const invoke = jest.fn(async () => ({
      status: "success" as const,
      content: "ok",
    }));
    const tool = new McpExecutableTool({
      serverName: "fixture",
      remoteTool: {
        name: "navigate",
        inputSchema: { type: "object", required: ["url"] },
      },
      invoke,
    });
    const registry = new ToolRegistry();
    registry.register(tool, true);

    expect("validateArguments" in tool).toBe(false);
    expect((await registry.executeWithStatus(tool.name, {})).status).toBe(
      "invalid_arguments",
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});
