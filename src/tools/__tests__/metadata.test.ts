import { describe, expect, it } from "@jest/globals";
import {
  createExecutableTool,
  createLocalTools,
  ToolRegistry,
  type ShellExecutor,
  type ToolMetadata,
} from "../index.js";
import { SkillTool } from "../skill.js";
import { McpExecutableTool } from "../../mcp/tool.js";
import { UNDECLARED_TOOL_METADATA } from "../../policy/index.js";

const readOnly: ToolMetadata = {
  capabilities: ["read"],
  readOnly: true,
  concurrencySafe: true,
};
const write: ToolMetadata = {
  capabilities: ["workspace_write"],
  readOnly: false,
  concurrencySafe: false,
};

describe("tool metadata", () => {
  it("is declared by every built-in local tool", () => {
    const definitions = createLocalTools({
      workspaceRoot: "/work/project",
      shellExecutor: (async () => {
        throw new Error("not used");
      }) as unknown as ShellExecutor,
    });

    expect(
      Object.fromEntries(
        definitions.map(({ tool }) => [tool.name, tool.metadata]),
      ),
    ).toEqual({
      read: readOnly,
      write,
      edit: write,
      bash: {
        capabilities: ["process"],
        readOnly: false,
        concurrencySafe: false,
      },
      grep: readOnly,
      find: readOnly,
      ls: readOnly,
    });
  });

  it("marks the skill tool as a read that must not run concurrently", () => {
    const tool = new SkillTool({} as never);
    expect(tool.metadata).toEqual({
      capabilities: ["read"],
      readOnly: true,
      concurrencySafe: false,
    });
  });

  it("treats MCP tools and undeclared tools as external and not concurrency-safe", () => {
    const registry = new ToolRegistry();
    const mcp = new McpExecutableTool({
      serverName: "github",
      remoteTool: { name: "list", inputSchema: { type: "object" } },
      invoke: async () => ({ status: "success", content: "ok" }),
    });
    const undeclared = createExecutableTool({
      schema: {
        type: "function",
        function: {
          name: "plain",
          description: "",
          parameters: { type: "object" },
        },
      },
      invoke: async () => ({ status: "success", content: "ok" }),
    });
    registry.register(mcp, true);
    registry.register(undeclared, false);

    expect(UNDECLARED_TOOL_METADATA).toEqual({
      capabilities: ["external"],
      readOnly: false,
      concurrencySafe: false,
    });
    expect(registry.getToolMetadata(mcp.name)).toEqual(
      UNDECLARED_TOOL_METADATA,
    );
    expect(registry.getToolMetadata("plain")).toEqual(UNDECLARED_TOOL_METADATA);
    expect(registry.getToolMetadata("missing")).toBeUndefined();
  });

  it("carries declared metadata through createExecutableTool and the registry", () => {
    const registry = new ToolRegistry();
    registry.register(
      createExecutableTool({
        schema: {
          type: "function",
          function: {
            name: "lookup",
            description: "",
            parameters: { type: "object" },
          },
        },
        invoke: async () => ({ status: "success", content: "ok" }),
        metadata: readOnly,
      }),
      true,
    );

    expect(registry.getToolMetadata("lookup")).toEqual(readOnly);
  });
});
