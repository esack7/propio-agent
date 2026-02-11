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

    it("should enable tool by default when registering", () => {
      const mockTool = createMockTool("test_tool");

      registry.register(mockTool);

      const result = registry.execute("test_tool", {});
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
    it("should execute disabled tool and return error", () => {
      const mockTool = createMockTool("test_tool");
      registry.register(mockTool);
      registry.disable("test_tool");

      const result = registry.execute("test_tool", {});

      expect(result).toBe("Tool not available: test_tool");
    });

    it("should execute nonexistent tool and return error", () => {
      const result = registry.execute("nonexistent", {});

      expect(result).toBe("Tool not found: nonexistent");
    });

    it("should execute successful tool and return result", () => {
      const mockTool = createMockTool("test_tool", "expected_result");
      registry.register(mockTool);

      const result = registry.execute("test_tool", { arg: "value" });

      expect(result).toBe("expected_result");
    });

    it("should execute throwing tool and return error string", () => {
      const throwingTool = createMockTool("throwing_tool");
      throwingTool.execute = jest.fn(() => {
        throw new Error("Test error");
      });
      registry.register(throwingTool);

      const result = registry.execute("throwing_tool", {});

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

  describe("multiple tools", () => {
    it("should manage multiple tools independently", () => {
      const tool1 = createMockTool("tool1", "result1");
      const tool2 = createMockTool("tool2", "result2");

      registry.register(tool1);
      registry.register(tool2);

      expect(registry.execute("tool1", {})).toBe("result1");
      expect(registry.execute("tool2", {})).toBe("result2");

      registry.disable("tool1");

      expect(registry.execute("tool1", {})).toBe("Tool not available: tool1");
      expect(registry.execute("tool2", {})).toBe("result2");
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
    execute: jest.fn(() => result),
  };
}
