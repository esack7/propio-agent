import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatTool } from "@propio-ai/providers";
import {
  createExecutableTool,
  createLocalTools,
  ToolRegistry,
  type ExecutableTool,
  type ShellExecutor,
} from "../index.js";
import { ToolArgumentValidator } from "../argumentValidation.js";

type Parameters = ChatTool["function"]["parameters"];

function spyTool(parameters: Parameters): {
  tool: ExecutableTool;
  execute: jest.Mock<() => Promise<string>>;
} {
  const execute = jest.fn(async () => "ran");
  return {
    execute,
    tool: {
      name: "spy",
      description: "Spy tool",
      getSchema: () => ({
        type: "function",
        function: { name: "spy", description: "Spy tool", parameters },
      }),
      execute,
    },
  };
}

const strictSchema: Parameters = {
  type: "object",
  properties: {
    path: { type: "string" },
    limit: { type: "integer", minimum: 1 },
    mode: { type: "string", enum: ["fast", "safe"] },
  },
  required: ["path"],
  additionalProperties: false,
};

describe("ToolRegistry argument validation", () => {
  it("runs a call whose arguments match the schema", async () => {
    const { tool, execute } = spyTool(strictSchema);
    const registry = new ToolRegistry();
    registry.register(tool, true);

    await expect(
      registry.executeWithStatus("spy", { path: "a", limit: 2, mode: "safe" }),
    ).resolves.toEqual({ status: "success", content: "ran" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a missing required property", {}, "must have required property 'path'"],
    ["a wrong type", { path: 7 }, "/path: must be string"],
    ["a non-integer", { path: "a", limit: 1.5 }, "/limit: must be integer"],
    [
      "a value below the minimum",
      { path: "a", limit: 0 },
      "/limit: must be >= 1",
    ],
    [
      "a value outside the enum",
      { path: "a", mode: "other" },
      '/mode: must be one of ["fast","safe"]',
    ],
    [
      "an undeclared property",
      { path: "a", extra: true },
      "unexpected property 'extra'",
    ],
    [
      "a string where a number is expected",
      { path: "a", limit: "2" },
      "/limit",
    ],
    ["null for an optional property", { path: "a", limit: null }, "/limit"],
  ])("does not run a call with %s", async (_label, args, expected) => {
    const { tool, execute } = spyTool(strictSchema);
    const registry = new ToolRegistry();
    registry.register(tool, true);

    const result = await registry.executeWithStatus(
      "spy",
      args as Record<string, unknown>,
    );

    expect(result.status).toBe("invalid_arguments");
    expect(result.content).toContain("Invalid arguments for spy");
    expect(result.content).toContain(expected);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports every failing path in one result", async () => {
    const { tool } = spyTool(strictSchema);
    const registry = new ToolRegistry();
    registry.register(tool, true);

    const result = await registry.executeWithStatus("spy", {
      limit: "x",
      mode: 3,
    });

    expect(result.content).toContain("must have required property 'path'");
    expect(result.content).toContain("/limit: must be integer");
    expect(result.content).toContain("/mode:");
  });

  it("rejects arguments that are not an object", async () => {
    const { tool, execute } = spyTool(strictSchema);
    const registry = new ToolRegistry();
    registry.register(tool, true);

    for (const args of [null, "text", ["a"]]) {
      const result = await registry.executeWithStatus(
        "spy",
        args as unknown as Record<string, unknown>,
      );
      expect(result.status).toBe("invalid_arguments");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates before asking for approval", async () => {
    const approve = jest.fn(() => true);
    const { tool, execute } = spyTool(strictSchema);
    const registry = new ToolRegistry({ approve });
    registry.register(tool, true);

    const result = await registry.executeWithStatus("spy", { path: 1 });

    expect(result.status).toBe("invalid_arguments");
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not coerce or default the arguments it passes on", async () => {
    const { tool, execute } = spyTool({
      type: "object",
      properties: { path: { type: "string" }, depth: { default: 3 } },
      required: ["path"],
    });
    const registry = new ToolRegistry();
    registry.register(tool, true);
    const args = { path: "a" };

    await registry.executeWithStatus("spy", args);

    expect(args).toEqual({ path: "a" });
    expect(execute).toHaveBeenCalledWith({ path: "a" }, expect.anything());
  });

  it("fails closed when a tool's schema cannot be compiled", async () => {
    const { tool, execute } = spyTool({
      type: "object",
      properties: { path: { $ref: "#/definitions/missing" } },
    });
    const registry = new ToolRegistry();
    registry.register(tool, true);

    const result = await registry.executeWithStatus("spy", { path: "a" });

    expect(result.status).toBe("error");
    expect(result.content).toContain("argument schema is not usable");
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts schemas that name a newer draft or use unknown keywords", async () => {
    const { tool, execute } = spyTool({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { when: { type: "string", format: "date-time" } },
      "x-vendor": true,
    });
    const registry = new ToolRegistry();
    registry.register(tool, true);

    await expect(
      registry.executeWithStatus("spy", { when: "not checked" }),
    ).resolves.toMatchObject({ status: "success" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("follows a tool whose schema changes between calls", async () => {
    let parameters: Parameters = { type: "object", required: ["a"] };
    const { tool } = spyTool(parameters);
    tool.getSchema = () => ({
      type: "function",
      function: { name: "spy", description: "Spy tool", parameters },
    });
    const registry = new ToolRegistry();
    registry.register(tool, true);

    expect((await registry.executeWithStatus("spy", {})).status).toBe(
      "invalid_arguments",
    );
    parameters = { type: "object" };
    expect((await registry.executeWithStatus("spy", {})).status).toBe(
      "success",
    );
  });
});

describe("tool-owned argument checks", () => {
  it("replace the registry's schema check", async () => {
    const execute = jest.fn(async () => "ran");
    const validateArguments = jest.fn(
      (args: Readonly<Record<string, unknown>>) =>
        args.allowed === true
          ? undefined
          : { status: "invalid_arguments" as const, content: "owner says no" },
    );
    const registry = new ToolRegistry();
    registry.register(
      {
        ...spyTool({ type: "object", required: ["path"] }).tool,
        execute,
        validateArguments,
      },
      true,
    );

    // The schema would reject both calls; only the owner's answer counts.
    await expect(
      registry.executeWithStatus("spy", { allowed: false }),
    ).resolves.toEqual({
      status: "invalid_arguments",
      content: "owner says no",
    });
    await expect(
      registry.executeWithStatus("spy", { allowed: true }),
    ).resolves.toMatchObject({ status: "success" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(registry.validateArguments("spy", { allowed: false })).toEqual({
      status: "invalid_arguments",
      content: "owner says no",
    });
  });

  it("are carried through createExecutableTool", () => {
    const validateArguments = () => ({
      status: "invalid_arguments" as const,
      content: "owner says no",
    });
    const tool = createExecutableTool({
      schema: {
        type: "function",
        function: {
          name: "t",
          description: "",
          parameters: { type: "object" },
        },
      },
      invoke: async () => ({ status: "success", content: "ran" }),
      validateArguments,
    });

    expect(tool.validateArguments?.({})).toEqual(validateArguments());
  });

  it("report nothing for unknown or disabled tools", () => {
    const registry = new ToolRegistry();
    registry.register(spyTool(strictSchema).tool, false);

    expect(registry.validateArguments("missing", {})).toBeUndefined();
    expect(registry.validateArguments("spy", {})).toBeUndefined();
  });
});

describe("ToolRegistry validates the arguments that run", () => {
  function capturingTool() {
    const received: unknown[] = [];
    const { tool } = spyTool(strictSchema);
    tool.execute = async (args) => {
      // Copy at dispatch: the caller may change its object afterwards.
      received.push(structuredClone(args));
      return "ran";
    };
    return { tool, received };
  }

  it("does not run arguments the caller made invalid after the first check", async () => {
    const { tool, received } = capturingTool();
    const registry = new ToolRegistry();
    registry.register(tool, true);
    const args: Record<string, unknown> = { path: "a" };

    const pending = registry.executeWithStatus("spy", args);
    args.path = 7;

    await expect(pending).resolves.toMatchObject({
      status: "invalid_arguments",
      content: expect.stringContaining("/path: must be string"),
    });
    expect(received).toEqual([]);
  });

  it("runs the arguments as they stand at dispatch when they are still valid", async () => {
    const { tool, received } = capturingTool();
    const registry = new ToolRegistry();
    registry.register(tool, true);
    const args: Record<string, unknown> = { path: "a" };

    const pending = registry.executeWithStatus("spy", args);
    args.path = "b";

    await expect(pending).resolves.toMatchObject({ status: "success" });
    expect(received).toEqual([{ path: "b" }]);
  });

  it("validates and runs the approval snapshot", async () => {
    const { tool, received } = capturingTool();
    const args: Record<string, unknown> = { path: "a" };
    const registry = new ToolRegistry({
      approve: () => {
        args.path = 7;
        return true;
      },
    });
    registry.register(tool, true);

    await expect(
      registry.executeWithStatus("spy", args),
    ).resolves.toMatchObject({ status: "success" });
    expect(received).toEqual([{ path: "a" }]);
  });
});

describe("ToolArgumentValidator", () => {
  const tuple = {
    type: "object",
    properties: {
      point: {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
        items: false,
      },
    },
  };

  it.each([
    ["no $schema", tuple],
    [
      "an explicit 2020-12 $schema",
      { $schema: "https://json-schema.org/draft/2020-12/schema", ...tuple },
    ],
  ])("applies 2020-12 tuple rules with %s", (_label, schema) => {
    const validator = new ToolArgumentValidator();

    expect(validator.check("t", schema, { point: ["a", 1] })).toBeUndefined();
    expect(validator.check("t", schema, { point: [1, 1] })?.status).toBe(
      "invalid_arguments",
    );
    expect(validator.check("t", schema, { point: ["a", 1, 2] })?.status).toBe(
      "invalid_arguments",
    );
  });

  it("applies 2019-09 rules when the schema declares them", () => {
    const validator = new ToolArgumentValidator();
    const schema = {
      $schema: "https://json-schema.org/draft/2019-09/schema",
      type: "object",
      dependentRequired: { a: ["b"] },
    };

    expect(validator.check("t", schema, { a: 1, b: 2 })).toBeUndefined();
    expect(validator.check("t", schema, { a: 1 })?.status).toBe(
      "invalid_arguments",
    );
  });

  const legacyTuple = {
    type: "object",
    properties: {
      point: {
        type: "array",
        items: [{ type: "string" }, { type: "number" }],
        additionalItems: false,
      },
    },
  };

  it.each([
    ["a draft-07 $schema", "http://json-schema.org/draft-07/schema#"],
    ["no $schema, which does not compile as 2020-12", undefined],
  ])("applies draft-07 tuple rules with %s", (_label, $schema) => {
    const validator = new ToolArgumentValidator();
    const schema = $schema ? { $schema, ...legacyTuple } : legacyTuple;

    expect(validator.check("t", schema, { point: ["a", 1] })).toBeUndefined();
    expect(validator.check("t", schema, { point: [1, 1] })?.status).toBe(
      "invalid_arguments",
    );
    expect(validator.check("t", schema, { point: ["a", 1, 2] })?.status).toBe(
      "invalid_arguments",
    );
  });

  it.each([
    ["draft-07 without a fragment", "http://json-schema.org/draft-07/schema"],
    ["draft-07 over https", "https://json-schema.org/draft-07/schema#"],
    [
      "2020-12 with an empty fragment",
      "https://json-schema.org/draft/2020-12/schema#",
    ],
    ["2019-09 over http", "http://json-schema.org/draft/2019-09/schema"],
  ])("accepts %s", (_label, $schema) => {
    const validator = new ToolArgumentValidator();
    const schema = { $schema, type: "object", required: ["a"] };

    expect(validator.check("t", schema, { a: 1 })).toBeUndefined();
    expect(validator.check("t", schema, {})?.status).toBe("invalid_arguments");
  });

  it.each([
    ["an unknown dialect", "https://example.com/my-dialect/schema"],
    ["draft-04", "http://json-schema.org/draft-04/schema#"],
    ["draft-06", "http://json-schema.org/draft-06/schema#"],
    [
      "a supported dialect named inside another URI",
      "https://example.com/draft/2020-12/schema",
    ],
    [
      "a non-empty fragment",
      "https://json-schema.org/draft/2020-12/schema#meta",
    ],
    ["a relative reference", "draft-07/schema"],
    ["an empty string", ""],
    ["a non-string value", 7],
  ])("fails closed on %s", (_label, $schema) => {
    const validator = new ToolArgumentValidator();
    const schema = { $schema, type: "object" };

    const result = validator.check("t", schema, {});

    expect(result?.status).toBe("error");
    expect(result?.content).toContain("argument schema is not usable");
    expect(result?.content).toMatch(
      /unsupported JSON Schema dialect|\$schema must be a string/,
    );
  });

  it("treats an undeclared dialect as 2020-12 only when the fallback is off", () => {
    const strict = new ToolArgumentValidator({ draft07Fallback: false });

    expect(strict.check("t", legacyTuple, { point: ["a", 1] })).toMatchObject({
      status: "error",
      content: expect.stringContaining("argument schema is not usable"),
    });
    expect(strict.check("t", tuple, { point: ["a", 1] })).toBeUndefined();
    expect(
      strict.check(
        "t",
        { $schema: "http://json-schema.org/draft-07/schema#", ...legacyTuple },
        { point: ["a", 1] },
      ),
    ).toBeUndefined();
  });

  it("does not fall back to another dialect when one is declared", () => {
    const validator = new ToolArgumentValidator();
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...legacyTuple,
    };

    expect(validator.check("t", schema, { point: ["a", 1] })?.status).toBe(
      "error",
    );
  });

  it("refuses an asynchronous schema instead of treating its promise as valid", () => {
    const validator = new ToolArgumentValidator();
    const schema = { $async: true, type: "object", required: ["a"] };

    const result = validator.check("t", schema, {});

    expect(result?.status).toBe("error");
    expect(result?.content).toContain("asynchronous schemas");
  });

  it("accepts different schemas that declare the same $id", () => {
    const validator = new ToolArgumentValidator();
    const $id = "https://example.com/tool.json";

    expect(
      validator.check("a", { $id, type: "object", required: ["a"] }, {})
        ?.status,
    ).toBe("invalid_arguments");
    expect(validator.check("b", { $id, type: "object" }, {})).toBeUndefined();
    expect(
      new ToolArgumentValidator().check("c", { $id, type: "object" }, {}),
    ).toBeUndefined();
  });

  it("is unaffected by later changes to a schema object it has seen", () => {
    const validator = new ToolArgumentValidator();
    const schema: { type: string; required: string[] } = {
      type: "object",
      required: ["a"],
    };
    expect(validator.check("t", schema, {})?.status).toBe("invalid_arguments");

    schema.required = [];

    expect(validator.check("t", schema, {})).toBeUndefined();
    expect(
      validator.check("t", { type: "object", required: ["a"] }, {})?.status,
    ).toBe("invalid_arguments");
  });
});

describe("built-in tools", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "propio-tools-validation-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("are unreachable with schema-invalid arguments", async () => {
    const shellExecutor = jest.fn() as unknown as ShellExecutor;
    const definitions = createLocalTools({
      workspaceRoot: workspace,
      shellExecutor,
    });
    const registry = new ToolRegistry();
    const implementations: jest.SpiedFunction<ExecutableTool["execute"]>[] = [];
    for (const { tool } of definitions) {
      implementations.push(jest.spyOn(tool, "execute"));
      if (tool.executeWithStatus) {
        implementations.push(jest.spyOn(tool, "executeWithStatus") as never);
      }
      registry.register(tool, true);
    }
    expect(definitions.length).toBeGreaterThan(0);

    for (const { tool } of definitions) {
      const { required = [], properties = {} } =
        tool.getSchema().function.parameters;
      // Every built-in declares required arguments; a tool without any would
      // need its own invalid case here.
      expect(required.length).toBeGreaterThan(0);
      const wrongTypes = Object.fromEntries(
        Object.keys(properties).map((key) => [key, { not: "a scalar" }]),
      );

      for (const args of [{}, wrongTypes]) {
        const result = await registry.executeWithStatus(tool.name, args);
        expect({ tool: tool.name, status: result.status }).toEqual({
          tool: tool.name,
          status: "invalid_arguments",
        });
      }
    }

    for (const implementation of implementations) {
      expect(implementation).not.toHaveBeenCalled();
    }
    expect(shellExecutor).not.toHaveBeenCalled();
    expect(await readdir(workspace)).toEqual([]);
  });
});
