import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ToolExecutionResult } from "./types.js";

interface ToolArgumentIssue {
  /** JSON Pointer to the offending value; empty for the argument object itself. */
  readonly path: string;
  readonly message: string;
}

type CompiledSchema =
  { readonly validate: ValidateFunction } | { readonly schemaError: string };

/**
 * Checks tool arguments against the JSON Schema a tool advertises.
 *
 * Arguments are never coerced or defaulted: a call either matches the schema as
 * sent or is rejected. The dialect follows the schema's `$schema`. A schema
 * that declares none is read as JSON Schema 2020-12, the MCP default, and as
 * draft-07 only if it does not compile as 2020-12. Compiled schemas are cached on the instance, so separate
 * registries share nothing.
 */
export class ToolArgumentValidator {
  private readonly compiled = new Map<string, CompiledSchema>();

  /** Returns a result to send to the model when the call must not run. */
  check(
    toolName: string,
    schema: unknown,
    args: unknown,
  ): ToolExecutionResult | undefined {
    const compiled = this.compile(schema);
    if ("schemaError" in compiled) {
      return {
        status: "error",
        content: `Tool ${toolName} cannot be called: its argument schema is not usable (${compiled.schemaError}).`,
      };
    }
    // Anything but a literal true is a failure, so a validator that returned
    // a promise or another truthy value could never pass a call through.
    if (compiled.validate(args) === true) return undefined;
    return {
      status: "invalid_arguments",
      content: formatIssues(toolName, toIssues(compiled.validate.errors)),
    };
  }

  private compile(schema: unknown): CompiledSchema {
    let key: string;
    try {
      key = JSON.stringify(schema);
    } catch (error) {
      return { schemaError: errorMessage(error) };
    }
    const cached = this.compiled.get(key);
    if (cached) return cached;

    let entry: CompiledSchema;
    if (!isSchemaObject(schema)) {
      entry = { schemaError: "schema must be an object" };
    } else {
      // Compile a detached copy so later changes to the caller's object
      // cannot alter a cached validator.
      entry = compileForDialect(JSON.parse(key) as Record<string, unknown>);
    }
    this.compiled.set(key, entry);
    return entry;
  }
}

type Dialect = "draft-07" | "2019-09" | "2020-12";

const AJV_OPTIONS = {
  allErrors: true,
  strict: false,
  validateFormats: false,
  validateSchema: false,
} as const;

function declaredDialect(schema: Record<string, unknown>): Dialect | undefined {
  const uri = schema.$schema;
  if (typeof uri !== "string") return undefined;
  if (uri.includes("2020-12")) return "2020-12";
  if (uri.includes("2019-09")) return "2019-09";
  // Drafts 04 and 06 have no class of their own; draft-07 is the closest.
  return "draft-07";
}

function compileForDialect(schema: Record<string, unknown>): CompiledSchema {
  const declared = declaredDialect(schema);
  if (declared) return compileWith(declared, schema);
  const current = compileWith("2020-12", schema);
  if ("validate" in current) return current;
  const legacy = compileWith("draft-07", schema);
  return "validate" in legacy ? legacy : current;
}

/**
 * One Ajv instance per schema. Ajv registers every `$id` it compiles, so a
 * shared instance would refuse a second tool, or a changed tool, that reuses
 * an id.
 */
function compileWith(
  dialect: Dialect,
  schema: Record<string, unknown>,
): CompiledSchema {
  try {
    const ajv =
      dialect === "2020-12"
        ? new Ajv2020(AJV_OPTIONS)
        : dialect === "2019-09"
          ? new Ajv2019(AJV_OPTIONS)
          : new Ajv(AJV_OPTIONS);
    const validate = ajv.compile(schema);
    // An async validator returns a promise, which would read as "valid".
    if ("$async" in validate && validate.$async) {
      return { schemaError: "asynchronous schemas ($async) are not supported" };
    }
    return { validate };
  } catch (error) {
    return { schemaError: errorMessage(error) };
  }
}

function isSchemaObject(schema: unknown): schema is Record<string, unknown> {
  return (
    typeof schema === "object" && schema !== null && !Array.isArray(schema)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toIssues(
  errors: ErrorObject[] | null | undefined,
): ToolArgumentIssue[] {
  const issues: ToolArgumentIssue[] = [];
  const seen = new Set<string>();
  for (const error of errors ?? []) {
    const issue = {
      path: error.instancePath,
      message: describeError(error),
    };
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  return issues;
}

function describeError(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  if (
    error.keyword === "additionalProperties" &&
    typeof params.additionalProperty === "string"
  ) {
    return `unexpected property '${params.additionalProperty}'`;
  }
  if (error.keyword === "enum" && Array.isArray(params.allowedValues)) {
    return `must be one of ${JSON.stringify(params.allowedValues)}`;
  }
  return error.message ?? `failed '${error.keyword}'`;
}

function formatIssues(
  toolName: string,
  issues: ReadonlyArray<ToolArgumentIssue>,
): string {
  const lines = issues.map(
    (issue) => `- ${issue.path || "(arguments)"}: ${issue.message}`,
  );
  return [
    `Invalid arguments for ${toolName}. The tool was not run.`,
    ...lines,
    "Correct the arguments and call the tool again.",
  ].join("\n");
}
