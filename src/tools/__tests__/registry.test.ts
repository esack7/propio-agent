import { ToolRegistry } from "../registry.js";
import { ExecutableTool } from "../interface.js";
import { ChatTool } from "../../providers/types.js";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("register", () => {
    it("registers tools without enabling them by default", async () => {
      const mockTool = createMockTool("test_tool");

      registry.register(mockTool);

      expect(registry.getToolNames()).toEqual(["test_tool"]);
      expect(registry.getEnabledSchemas()).toHaveLength(0);
      await expect(registry.execute("test_tool", {})).resolves.toBe(
        "Tool not available: test_tool",
      );
    });

    it("enables a tool when explicitly requested during registration", async () => {
      const mockTool = createMockTool("test_tool");

      registry.register(mockTool, true);

      expect(registry.getEnabledSchemas()).toHaveLength(1);
      await expect(registry.execute("test_tool", {})).resolves.toBe("success");
    });
  });

  describe("unregister", () => {
    it("removes a tool from the registry", () => {
      const mockTool = createMockTool("test_tool");
      registry.register(mockTool, true);

      registry.unregister("test_tool");

      expect(registry.getToolNames()).toEqual([]);
      expect(registry.getEnabledSchemas()).toHaveLength(0);
    });

    it("is idempotent when unregistering a missing tool", () => {
      expect(() => registry.unregister("missing")).not.toThrow();
    });
  });

  describe("enable and disable", () => {
    it("toggles schema visibility", () => {
      const mockTool = createMockTool("test_tool");
      registry.register(mockTool);

      registry.enable("test_tool");
      expect(registry.getEnabledSchemas()).toHaveLength(1);

      registry.disable("test_tool");
      expect(registry.getEnabledSchemas()).toHaveLength(0);
    });
  });

  describe("execute", () => {
    it("returns tool_not_found for missing tools", async () => {
      expect(await registry.execute("missing", {})).toBe(
        "Tool not found: missing",
      );
    });

    it("returns an error string for throwing tools", async () => {
      const throwingTool = createMockTool("throwing_tool");
      throwingTool.execute = jest.fn(async () => {
        throw new Error("Test error");
      });

      registry.register(throwingTool, true);

      expect(await registry.execute("throwing_tool", {})).toBe(
        "Error executing throwing_tool: Test error",
      );
    });
  });

  describe("executeWithStatus", () => {
    it("returns structured status values", async () => {
      const mockTool = createMockTool("test_tool", "expected_result");
      registry.register(mockTool, true);

      const success = await registry.executeWithStatus("test_tool", {});
      expect(success).toEqual({
        status: "success",
        content: "expected_result",
      });

      const missing = await registry.executeWithStatus("missing", {});
      expect(missing).toEqual({
        status: "tool_not_found",
        content: "Tool not found: missing",
      });

      registry.disable("test_tool");
      const disabled = await registry.executeWithStatus("test_tool", {});
      expect(disabled).toEqual({
        status: "tool_disabled",
        content: "Tool not available: test_tool",
      });
    });

    it("returns tool_not_found for legacy tool names", async () => {
      for (const legacyName of [
        "read_file",
        "write_file",
        "list_dir",
        "mkdir",
        "move",
        "remove",
        "search_text",
        "search_files",
        "run_bash",
      ]) {
        await expect(
          registry.executeWithStatus(legacyName, {}),
        ).resolves.toEqual({
          status: "tool_not_found",
          content: `Tool not found: ${legacyName}`,
        });
      }
    });
  });

  describe("introspection", () => {
    it("preserves registration order", () => {
      registry.register(createMockTool("tool1"), true);
      registry.register(createMockTool("tool2"));
      registry.register(createMockTool("tool3"), true);

      expect(registry.getToolNames()).toEqual(["tool1", "tool2", "tool3"]);
      expect(
        registry.getEnabledSchemas().map((s: ChatTool) => s.function.name),
      ).toEqual(["tool1", "tool3"]);
    });

    it("reports enabled state accurately", () => {
      registry.register(createMockTool("test_tool"));
      expect(registry.hasTool("test_tool")).toBe(true);
      expect(registry.isToolEnabled("test_tool")).toBe(false);

      registry.enable("test_tool");
      expect(registry.isToolEnabled("test_tool")).toBe(true);
    });
  });
});

function createMockTool(
  name: string,
  result: string = "success",
): ExecutableTool {
  return {
    name,
    getSchema(): ChatTool {
      return {
        type: "function",
        function: {
          name,
          description: `Mock tool ${name}`,
          parameters: {
            type: "object",
            properties: {},
          },
        },
      };
    },
    execute: jest.fn(async () => result),
  };
}
