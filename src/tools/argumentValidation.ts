import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
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
 * sent or is rejected. Compiled schemas are cached on the instance, so separate
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
    if (compiled.validate(args)) return undefined;
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
      try {
        // Compile a detached copy so later changes to the caller's object
        // cannot alter a cached validator.
        entry = { validate: newAjv().compile(JSON.parse(key)) };
      } catch (error) {
        entry = { schemaError: errorMessage(error) };
      }
    }
    this.compiled.set(key, entry);
    return entry;
  }
}

/**
 * One instance per schema. Ajv registers every `$id` it compiles, so a shared
 * instance would refuse a second tool, or a changed tool, that reuses an id.
 */
function newAjv(): Ajv {
  return new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: false,
    validateSchema: false,
  });
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
