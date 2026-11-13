import { escape, minimatch } from "minimatch";
import { isCapability, type Capability } from "./capabilities.js";

export type RuleEffect = "allow" | "ask" | "deny";

/**
 * What a call acts on, derived by the application that knows the tool. Paths
 * are absolute, normalized, and already resolved through symbolic links.
 */
export type PolicyTarget =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "mcp"; readonly serverPrefix: string };

export type ParsedRule =
  | { readonly kind: "capability"; readonly capability: Capability }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly pattern?: string;
    };

export interface PolicyRule {
  /** The rule as written, used as its identity and in decisions. */
  readonly text: string;
  readonly parsed: ParsedRule;
}

export class PolicyRuleError extends Error {
  constructor(
    readonly ruleText: string,
    /** Zero-based offset of the first character that could not be read. */
    readonly position: number,
    detail: string,
  ) {
    super(
      `Invalid permission rule "${ruleText}" at position ${position}: ${detail}`,
    );
    this.name = "PolicyRuleError";
  }
}

const CAPABILITY_PREFIX = "capability:";
const TOOL_NAME = /^[A-Za-z0-9_.-]+/;

export function parseRule(input: unknown): PolicyRule {
  if (typeof input !== "string") {
    throw new PolicyRuleError(String(input), 0, "a rule must be a string");
  }
  const text = input.trim();
  if (text.length === 0) {
    throw new PolicyRuleError(input, 0, "a rule must not be empty");
  }
  if (text.startsWith(CAPABILITY_PREFIX)) {
    const capability = text.slice(CAPABILITY_PREFIX.length);
    if (!isCapability(capability)) {
      throw new PolicyRuleError(
        text,
        CAPABILITY_PREFIX.length,
        `unknown capability "${capability}"`,
      );
    }
    return { text, parsed: { kind: "capability", capability } };
  }

  const name = TOOL_NAME.exec(text)?.[0] ?? "";
  if (name.length === 0) {
    throw new PolicyRuleError(text, 0, "expected a tool name");
  }
  if (name.length === text.length) {
    return { text, parsed: { kind: "tool", name } };
  }
  if (text[name.length] !== "(") {
    throw new PolicyRuleError(
      text,
      name.length,
      'expected "(" or the end of the rule after the tool name',
    );
  }
  if (!text.endsWith(")")) {
    throw new PolicyRuleError(text, text.length, 'expected a closing ")"');
  }
  const pattern = text.slice(name.length + 1, -1).trim();
  if (pattern.length === 0) {
    throw new PolicyRuleError(
      text,
      name.length + 1,
      "a pattern must not be empty; omit the parentheses to match every call",
    );
  }
  return { text, parsed: { kind: "tool", name, pattern } };
}

export interface RuleMatchInput {
  readonly toolName: string;
  readonly capabilities: readonly Capability[];
  readonly target?: PolicyTarget;
}

export interface RuleMatchContext {
  /** Absolute. Relative path patterns are read against it. */
  readonly workspaceRoot: string;
  /** Absolute. Without it a `~/` pattern matches nothing. */
  readonly homeDir?: string;
}

/**
 * Whether a rule applies to a call. Allow rules are read narrowly and deny and
 * ask rules broadly, so an unclear case never widens what runs unasked.
 */
export function ruleMatches(
  rule: PolicyRule,
  effect: RuleEffect,
  input: RuleMatchInput,
  context: RuleMatchContext,
): boolean {
  const parsed = rule.parsed;
  if (parsed.kind === "capability") {
    return input.capabilities.includes(parsed.capability);
  }
  const namesTool = parsed.name === input.toolName;
  const namesServer =
    input.target?.kind === "mcp" && parsed.name === input.target.serverPrefix;
  if (!namesTool && !namesServer) return false;
  if (parsed.pattern === undefined) return true;
  // A pattern narrows one tool; it has no meaning for a whole MCP server.
  if (!namesTool) return false;

  if (input.target?.kind === "path") {
    return pathMatches(parsed.pattern, input.target.path, context);
  }
  if (input.target?.kind === "command") {
    return commandMatches(parsed.pattern, input.target.command, effect);
  }
  // No target to compare against. A deny or ask rule still applies, so a
  // pattern can never be the reason a restricted tool runs unasked.
  return effect !== "allow";
}

function pathMatches(
  pattern: string,
  path: string,
  context: RuleMatchContext,
): boolean {
  const absolute = absolutePattern(pattern, context);
  if (absolute === undefined) return false;
  // The syntax has no negation, so a leading "!" is never read as one.
  return minimatch(path, absolute, {
    dot: true,
    nocomment: true,
    nonegate: true,
  });
}

function absolutePattern(
  pattern: string,
  context: RuleMatchContext,
): string | undefined {
  if (pattern.startsWith("/")) return pattern;
  if (pattern === "~" || pattern.startsWith("~/")) {
    return context.homeDir === undefined
      ? undefined
      : joinPath(context.homeDir, pattern.slice(1));
  }
  return joinPath(context.workspaceRoot, pattern.replace(/^\.\//, ""));
}

function joinPath(root: string, rest: string): string {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  const tail = rest.startsWith("/") ? rest.slice(1) : rest;
  return tail.length === 0 ? base || "/" : `${base}/${tail}`;
}

const PREFIX_SUFFIX = ":*";
/** Anything that chains, substitutes, redirects, or backgrounds a command. */
const SHELL_OPERATOR = /[;&|<>`\n\r]|\$\(/;
const SEGMENT_SEPARATOR = /[;&|\n\r`()]|\$\(/;

function commandMatches(
  pattern: string,
  command: string,
  effect: RuleEffect,
): boolean {
  const whole = command.trim();
  if (effect === "allow") {
    // An allow rule never covers a compound command: approving one command
    // must not approve whatever is chained after it. The test ignores quoting
    // on purpose, which can only send more commands to a prompt.
    return !SHELL_OPERATOR.test(whole) && simpleCommandMatches(pattern, whole);
  }
  if (simpleCommandMatches(pattern, whole)) return true;
  return whole
    .split(SEGMENT_SEPARATOR)
    .some((segment) => simpleCommandMatches(pattern, segment.trim()));
}

function simpleCommandMatches(pattern: string, command: string): boolean {
  if (command.length === 0) return false;
  if (!pattern.endsWith(PREFIX_SUFFIX)) return command === pattern;
  const prefix = pattern.slice(0, -PREFIX_SUFFIX.length).trim();
  if (prefix.length === 0) return true;
  return command === prefix || command.startsWith(`${prefix} `);
}

export function isCompoundCommand(command: string): boolean {
  return SHELL_OPERATOR.test(command);
}

/**
 * A pattern that matches exactly one path. minimatch's escape leaves braces,
 * which would otherwise expand, so those are escaped here as well.
 */
export function literalPathPattern(path: string): string {
  return escape(path).replace(/[{}]/g, "\\$&");
}
