import { ToolRegistry } from "../registry";
import { ExecutableTool } from "../interface";
import { ChatTool } from "../../providers/types";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("register", () => {
    it("should register a tool and make it available", () => {
      const mockTool = createMockTool("test_tool");

      registry.register(mockTool);
      const schemas = registry.getEnabledSchemas();

      expect(schemas).toHaveLength(1);
      expect(schemas[0].function.name).toBe("test_tool");
    });

    it("should enable tool by default when registering", async () => {
      const mockTool = createMockTool("test_tool");

      registry.register(mockTool);

      const result = await registry.execute("test_tool", {});
      expect(result).toBe("success");
    });
  });

  describe("unregister", () => {
    it("should unregister a tool and remove it from schemas", () => {
      const mockTool = createMockTool("test_tool");
      registry.register(mockTool);

      registry.unregister("test_tool");

      const schemas = registry.getEnabledSchemas();
      expect(schemas).toHaveLength(0);
    });

    it("should be idempotent when unregistering nonexistent tool", () => {
      expect(() => {
        registry.unregister("nonexistent");
      }).not.toThrow();
    });
  });

  describe("enable and disable", () => {
    it("should include tool in schemas when enabled", () => {
      const mockTool = createMockTool("test_tool");
      registry.register(mockTool);
      registry.disable("test_tool");

      registry.enable("test_tool");

      const schemas = registry.getEnabledSchemas();
      expect(schemas).toHaveLength(1);
      expect(schemas[0].function.name).toBe("test_tool");
    });

    it("should exclude tool from schemas when disabled", () => {
      const mockTool = createMockTool("test_tool");
      registry.register(mockTool);

      registry.disable("test_tool");

      const schemas = registry.getEnabledSchemas();
      expect(schemas).toHaveLength(0);
    });
  });

  describe("execute", () => {
    it("should execute disabled tool and return error", async () => {
      const mockTool = createMockTool("test_tool");
      registry.register(mockTool);
      registry.disable("test_tool");

      const result = await registry.execute("test_tool", {});

      expect(result).toBe("Tool not available: test_tool");
    });

    it("should execute nonexistent tool and return error", async () => {
      const result = await registry.execute("nonexistent", {});

      expect(result).toBe("Tool not found: nonexistent");
    });

    it("should execute successful tool and return result", async () => {
      const mockTool = createMockTool("test_tool", "expected_result");
      registry.register(mockTool);

      const result = await registry.execute("test_tool", { arg: "value" });

      expect(result).toBe("expected_result");
    });

    it("should execute throwing tool and return error string", async () => {
      const throwingTool = createMockTool("throwing_tool");
      throwingTool.execute = jest.fn(async () => {
        throw new Error("Test error");
      });
      registry.register(throwingTool);

      const result = await registry.execute("throwing_tool", {});

      expect(result).toBe("Error executing throwing_tool: Test error");
    });
  });

  describe("getEnabledSchemas", () => {
    it("should return only enabled tool schemas", () => {
      const tool1 = createMockTool("tool1");
      const tool2 = createMockTool("tool2");
      const tool3 = createMockTool("tool3");

      registry.register(tool1);
      registry.register(tool2);
      registry.register(tool3);
      registry.disable("tool2");

      const schemas = registry.getEnabledSchemas();

      expect(schemas).toHaveLength(2);
      expect(schemas.map((s: ChatTool) => s.function.name)).toEqual([
        "tool1",
        "tool3",
      ]);
    });
  });

  describe("introspection", () => {
    describe("getToolNames", () => {
      it("should return all registered tool names in registration order", () => {
        const tool1 = createMockTool("tool1");
        const tool2 = createMockTool("tool2");
        const tool3 = createMockTool("tool3");

        registry.register(tool1);
        registry.register(tool2);
        registry.register(tool3);

        const names = registry.getToolNames();

        expect(names).toEqual(["tool1", "tool2", "tool3"]);
      });

      it("should return empty array for empty registry", () => {
        const names = registry.getToolNames();

        expect(names).toEqual([]);
      });

      it("should return all tool names including disabled tools", () => {
        const tool1 = createMockTool("tool1");
        const tool2 = createMockTool("tool2");

        registry.register(tool1);
        registry.register(tool2);
        registry.disable("tool2");

        const names = registry.getToolNames();

        expect(names).toEqual(["tool1", "tool2"]);
      });
    });

    describe("hasTool", () => {
      it("should return true for registered tool", () => {
        const tool = createMockTool("test_tool");
        registry.register(tool);

        expect(registry.hasTool("test_tool")).toBe(true);
      });

      it("should return false for unregistered tool", () => {
        expect(registry.hasTool("nonexistent")).toBe(false);
      });

      it("should return true for registered but disabled tool", () => {
        const tool = createMockTool("test_tool");
        registry.register(tool);
        registry.disable("test_tool");

        expect(registry.hasTool("test_tool")).toBe(true);
      });
    });

    describe("isToolEnabled", () => {
      it("should return true for registered and enabled tool", () => {
        const tool = createMockTool("test_tool");
        registry.register(tool);

        expect(registry.isToolEnabled("test_tool")).toBe(true);
      });

      it("should return false for registered but disabled tool", () => {
        const tool = createMockTool("test_tool");
        registry.register(tool);
        registry.disable("test_tool");

        expect(registry.isToolEnabled("test_tool")).toBe(false);
      });

      it("should return false for unregistered tool", () => {
        expect(registry.isToolEnabled("nonexistent")).toBe(false);
      });

      it("should return true after re-enabling disabled tool", () => {
        const tool = createMockTool("test_tool");
        registry.register(tool);
        registry.disable("test_tool");
        registry.enable("test_tool");

        expect(registry.isToolEnabled("test_tool")).toBe(true);
      });
    });
  });

  describe("multiple tools", () => {
    it("should manage multiple tools independently", async () => {
      const tool1 = createMockTool("tool1", "result1");
      const tool2 = createMockTool("tool2", "result2");

      registry.register(tool1);
      registry.register(tool2);

      expect(await registry.execute("tool1", {})).toBe("result1");
      expect(await registry.execute("tool2", {})).toBe("result2");

      registry.disable("tool1");

      expect(await registry.execute("tool1", {})).toBe("Tool not available: tool1");
      expect(await registry.execute("tool2", {})).toBe("result2");
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
