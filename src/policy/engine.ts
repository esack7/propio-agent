import {
  ApprovalAnswerError,
  type ApprovalAnswer,
  type ApprovalRequest,
  type GrantSuggestion,
  type JsonObject,
} from "./approval.js";
import type { Capability, ToolMetadata } from "./capabilities.js";
import {
  isInsideWorkspace,
  modeDefault,
  type PermissionMode,
} from "./modes.js";
import {
  DEFAULT_PRESET_NAME,
  getPreset,
  type PermissionPreset,
} from "./presets.js";
import {
  isCompoundCommand,
  parseRule,
  ruleMatches,
  type PolicyRule,
  type PolicyTarget,
  type RuleEffect,
} from "./rules.js";
import type {
  OwnerScope,
  PermissionSettings,
  PermissionStore,
} from "./store.js";

export type RuleSource = "preset" | "user" | "session";

export interface PolicyRequest {
  readonly toolName: string;
  readonly args: JsonObject;
  readonly metadata: ToolMetadata;
  readonly target?: PolicyTarget;
  readonly sessionId?: string;
  readonly toolCallId?: string;
}

interface DecisionBase {
  /** The rule as written, `mode:<name>`, or `approval:<decision>`. */
  readonly rule: string;
  readonly reason: string;
  /** `user` when an operator's answer decided, `application` otherwise. */
  readonly actor: "application" | "user";
  readonly source: RuleSource | "mode" | "approval";
}

export type PolicyDecision =
  | (DecisionBase & { readonly outcome: "allow" | "deny" })
  | (DecisionBase & {
      readonly outcome: "ask";
      readonly request: ApprovalRequest;
    });

export interface PolicyEngineOptions {
  readonly store: PermissionStore;
  readonly owner: OwnerScope;
  /** Absolute, normalized, without symbolic links. */
  readonly workspaceRoot: string;
  /** Absolute. Required when any rule uses a `~/` pattern. */
  readonly homeDir?: string;
  /** Overrides the stored preset for this instance without saving it. */
  readonly preset?: string;
  /** Overrides the preset's mode for this instance. */
  readonly mode?: PermissionMode;
  /**
   * Identifiers for approval requests. Defaults to random UUIDs, so an answer
   * meant for one engine can never match a request raised by another.
   */
  readonly createRequestId?: () => string;
}

export interface PolicyDescription {
  readonly preset: string;
  readonly mode: PermissionMode;
  readonly rules: ReadonlyArray<{
    readonly effect: RuleEffect;
    readonly rule: string;
    readonly source: RuleSource;
  }>;
}

interface SourcedRule {
  readonly rule: PolicyRule;
  readonly effect: RuleEffect;
  readonly source: RuleSource;
}

const EFFECTS: readonly RuleEffect[] = ["deny", "ask", "allow"];

function isAbsolutePath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/");
}

/**
 * Decides whether a tool call may run. All state is on the instance: two
 * engines in one process share nothing unless they are given the same store
 * and owner.
 */
export class PolicyEngine {
  private readonly store: PermissionStore;
  private readonly owner: OwnerScope;
  private readonly workspaceRoot: string;
  private readonly homeDir?: string;
  private readonly createRequestId: () => string;
  private readonly pending = new Map<string, PolicyRequest>();
  private settings: PermissionSettings;
  private presetOverride?: string;
  private modeOverride?: PermissionMode;
  private preset: PermissionPreset;
  private userRules: SourcedRule[] = [];
  private presetRules: SourcedRule[] = [];
  private sessionGrants: PolicyRule[] = [];

  private constructor(
    options: PolicyEngineOptions,
    settings: PermissionSettings,
  ) {
    if (!isAbsolutePath(options.workspaceRoot)) {
      throw new Error("workspaceRoot must be an absolute path");
    }
    if (options.homeDir !== undefined && !isAbsolutePath(options.homeDir)) {
      throw new Error("homeDir must be an absolute path");
    }
    this.store = options.store;
    this.owner = options.owner;
    this.workspaceRoot = options.workspaceRoot;
    this.homeDir = options.homeDir;
    this.presetOverride = options.preset;
    this.modeOverride = options.mode;
    this.createRequestId =
      options.createRequestId ?? (() => `approval-${crypto.randomUUID()}`);
    this.settings = settings;
    this.preset = this.resolvePreset();
    this.rebuildRules();
  }

  /** Loads the owner's settings. A rule that cannot be read fails the load. */
  static async create(options: PolicyEngineOptions): Promise<PolicyEngine> {
    const settings = await options.store.load(options.owner);
    return new PolicyEngine(options, settings);
  }

  get mode(): PermissionMode {
    return this.modeOverride ?? this.preset.mode;
  }

  describe(): PolicyDescription {
    return {
      preset: this.preset.name,
      mode: this.mode,
      rules: [
        ...this.presetRules,
        ...this.userRules,
        ...this.sessionGrants.map((rule) => ({
          rule,
          effect: "allow" as const,
          source: "session" as const,
        })),
      ].map(({ rule, effect, source }) => ({
        effect,
        rule: rule.text,
        source,
      })),
    };
  }

  /** Decide a call. An `ask` outcome carries the request to put to someone. */
  evaluate(request: PolicyRequest): PolicyDecision {
    const input = {
      toolName: request.toolName,
      capabilities: request.metadata.capabilities,
      target: request.target,
    };
    const context = {
      workspaceRoot: this.workspaceRoot,
      homeDir: this.homeDir,
    };
    const rules = [
      ...this.presetRules,
      ...this.userRules,
      ...this.grantRules(),
    ];
    // Deny, then ask, then allow, whichever source a rule came from.
    for (const effect of EFFECTS) {
      const match = rules.find(
        (candidate) =>
          candidate.effect === effect &&
          ruleMatches(candidate.rule, effect, input, context),
      );
      if (!match) continue;
      const base: DecisionBase = {
        rule:
          match.source === "session"
            ? `session_grant:${match.rule.text}`
            : match.rule.text,
        reason: `Matched ${match.source} ${effect} rule ${match.rule.text}`,
        actor: "application",
        source: match.source,
      };
      return effect === "ask"
        ? this.ask(request, base)
        : { ...base, outcome: effect };
    }

    const fallback = modeDefault(
      this.mode,
      request.metadata,
      request.target,
      this.workspaceRoot,
    );
    const base: DecisionBase = {
      rule: `mode:${this.mode}`,
      reason: fallback.reason,
      actor: "application",
      source: "mode",
    };
    return fallback.outcome === "ask"
      ? this.ask(request, base)
      : { ...base, outcome: "allow" };
  }

  /**
   * Apply an answer to a request this engine raised. A grant is recorded
   * first, so the decision already reflects it; a deny rule still wins.
   */
  async answer(answer: ApprovalAnswer): Promise<PolicyDecision> {
    const request = this.pending.get(answer?.requestId);
    if (!request) {
      throw new ApprovalAnswerError(
        `No pending approval request with id ${String(answer?.requestId)}`,
      );
    }
    switch (answer.decision) {
      case "deny":
        this.pending.delete(answer.requestId);
        return {
          outcome: "deny",
          rule: "approval:deny",
          reason: answer.reason?.trim() || "Denied by the operator",
          actor: "user",
          source: "approval",
        };
      case "allow_once":
        this.pending.delete(answer.requestId);
        return this.approved("approval:allow_once", "Allowed once");
      case "allow_session": {
        const rule = this.grantableRule(answer.rule, request);
        this.pending.delete(answer.requestId);
        this.addSessionGrant(rule.text);
        return this.approved(
          `approval:allow_session:${rule.text}`,
          `Allowed for this session by ${rule.text}`,
        );
      }
      case "allow_always": {
        const rule = this.grantableRule(answer.rule, request);
        await this.addRule("allow", rule.text);
        this.pending.delete(answer.requestId);
        return this.approved(
          `approval:allow_always:${rule.text}`,
          `Always allowed by ${rule.text}`,
        );
      }
      default:
        throw new ApprovalAnswerError(
          `Unknown approval decision ${String((answer as { decision?: unknown }).decision)}`,
        );
    }
  }

  /** Drop a request that will not be answered, such as on cancellation. */
  abandon(requestId: string): void {
    this.pending.delete(requestId);
  }

  listSessionGrants(): readonly string[] {
    return this.sessionGrants.map((rule) => rule.text);
  }

  addSessionGrant(ruleText: string): void {
    const rule = this.checkedRule(ruleText);
    if (!this.sessionGrants.some((grant) => grant.text === rule.text)) {
      this.sessionGrants.push(rule);
    }
  }

  revokeSessionGrant(ruleText: string): boolean {
    const text = ruleText.trim();
    const before = this.sessionGrants.length;
    this.sessionGrants = this.sessionGrants.filter(
      (grant) => grant.text !== text,
    );
    return this.sessionGrants.length !== before;
  }

  /** Replace the grants, as when a session is resumed. All must be readable. */
  // Public API for consumers that persist sessions.
  // fallow-ignore-next-line unused-class-member
  restoreSessionGrants(ruleTexts: readonly string[]): void {
    const restored = ruleTexts.map((text) => this.checkedRule(text));
    this.sessionGrants = restored.filter(
      (rule, index) =>
        restored.findIndex((other) => other.text === rule.text) === index,
    );
  }

  /** Add a rule to the owner's stored settings, replacing it in other lists. */
  async addRule(effect: RuleEffect, ruleText: string): Promise<void> {
    const text = this.checkedRule(ruleText).text;
    const without = this.settingsWithout(text);
    await this.persist({ ...without, [effect]: [...without[effect], text] });
  }

  async removeRule(ruleText: string): Promise<boolean> {
    const text = ruleText.trim();
    const without = this.settingsWithout(text);
    const removed = EFFECTS.some(
      (effect) => without[effect].length !== this.settings[effect].length,
    );
    if (removed) await this.persist(without);
    return removed;
  }

  /** Select a preset for this instance; `persist` also stores it. */
  async setPreset(
    name: string,
    options: { persist?: boolean } = {},
  ): Promise<void> {
    if (!getPreset(name))
      throw new Error(`Unknown permission preset "${name}"`);
    if (options.persist) await this.persist({ ...this.settings, preset: name });
    this.presetOverride = name;
    this.modeOverride = undefined;
    this.preset = this.resolvePreset();
    this.rebuildRules();
  }

  setMode(mode: PermissionMode): void {
    this.modeOverride = mode;
  }

  private async persist(settings: PermissionSettings): Promise<void> {
    // Save first: a failed write leaves the rules in use unchanged.
    await this.store.save(this.owner, settings);
    this.settings = settings;
    this.preset = this.resolvePreset();
    this.rebuildRules();
  }

  private settingsWithout(text: string): PermissionSettings {
    const keep = (rules: readonly string[]) =>
      rules.filter((rule) => rule.trim() !== text);
    return {
      ...this.settings,
      allow: keep(this.settings.allow),
      ask: keep(this.settings.ask),
      deny: keep(this.settings.deny),
    };
  }

  private resolvePreset(): PermissionPreset {
    const name =
      this.presetOverride ?? this.settings.preset ?? DEFAULT_PRESET_NAME;
    const preset = getPreset(name);
    if (!preset) throw new Error(`Unknown permission preset "${name}"`);
    return preset;
  }

  private rebuildRules(): void {
    const collect = (
      lists: Pick<PermissionSettings, RuleEffect>,
      source: RuleSource,
    ): SourcedRule[] =>
      EFFECTS.flatMap((effect) => {
        const list: unknown = lists[effect] ?? [];
        if (!Array.isArray(list)) {
          throw new Error(`Permission ${effect} rules must be a list`);
        }
        return list.map((text) => ({
          rule: this.checkedRule(text),
          effect,
          source,
        }));
      });
    const userRules = collect(this.settings, "user");
    const presetRules = collect(this.preset, "preset");
    this.userRules = userRules;
    this.presetRules = presetRules;
  }

  private checkedRule(text: unknown): PolicyRule {
    const rule = parseRule(text);
    const pattern =
      rule.parsed.kind === "tool" ? rule.parsed.pattern : undefined;
    if (
      this.homeDir === undefined &&
      pattern !== undefined &&
      (pattern === "~" || pattern.startsWith("~/"))
    ) {
      // Without a home directory the rule could never match, which would
      // silently disable a deny.
      throw new Error(
        `Permission rule "${rule.text}" uses ~ but no home directory was provided`,
      );
    }
    return rule;
  }

  private grantRules(): SourcedRule[] {
    return this.sessionGrants.map((rule) => ({
      rule,
      effect: "allow",
      source: "session",
    }));
  }

  private grantableRule(ruleText: unknown, request: PolicyRequest): PolicyRule {
    let rule: PolicyRule;
    try {
      rule = this.checkedRule(ruleText);
    } catch (error) {
      throw new ApprovalAnswerError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const covers = ruleMatches(
      rule,
      "allow",
      {
        toolName: request.toolName,
        capabilities: request.metadata.capabilities,
        target: request.target,
      },
      { workspaceRoot: this.workspaceRoot, homeDir: this.homeDir },
    );
    if (!covers) {
      throw new ApprovalAnswerError(
        `Rule ${rule.text} does not cover the call it was offered for`,
      );
    }
    return rule;
  }

  private approved(rule: string, reason: string): PolicyDecision {
    return {
      outcome: "allow",
      rule,
      reason,
      actor: "user",
      source: "approval",
    };
  }

  private ask(request: PolicyRequest, base: DecisionBase): PolicyDecision {
    const approval: ApprovalRequest = {
      id: this.createRequestId(),
      ...(request.sessionId === undefined
        ? {}
        : { sessionId: request.sessionId }),
      ...(request.toolCallId === undefined
        ? {}
        : { toolCallId: request.toolCallId }),
      toolName: request.toolName,
      args: request.args,
      capabilities: [...request.metadata.capabilities],
      ...(request.target === undefined ? {} : { target: request.target }),
      reason: base.reason,
      rule: base.rule,
      suggestions: this.suggestions(request),
    };
    this.pending.set(approval.id, request);
    return { ...base, outcome: "ask", request: approval };
  }

  private suggestions(request: PolicyRequest): GrantSuggestion[] {
    const { toolName, target, metadata } = request;
    const candidates: GrantSuggestion[] = [
      ...this.exactSuggestion(request),
      {
        rule: toolName,
        scope: "tool",
        description: `every call to ${toolName}`,
      },
      ...(target?.kind === "mcp" && target.serverPrefix !== toolName
        ? [
            {
              rule: target.serverPrefix,
              scope: "server" as const,
              description: `every tool of ${target.serverPrefix}`,
            },
          ]
        : []),
      ...metadata.capabilities.map((capability: Capability) => ({
        rule: `capability:${capability}`,
        scope: "capability" as const,
        description: `every call with the ${capability} capability`,
      })),
    ];
    // Offer only grants that would actually cover this call.
    return candidates.filter((suggestion) => {
      try {
        this.grantableRule(suggestion.rule, request);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** The narrowest grant: this path, or this command when it is not compound. */
  private exactSuggestion(request: PolicyRequest): GrantSuggestion[] {
    const { toolName, target } = request;
    if (target?.kind === "path") {
      const pattern = this.workspaceRelative(target.path);
      return [
        {
          rule: `${toolName}(${pattern})`,
          scope: "exact",
          description: `${toolName} on ${pattern}`,
        },
      ];
    }
    if (target?.kind === "command") {
      const command = target.command.trim();
      // A compound command can never be covered by an allow rule.
      if (command.length === 0 || isCompoundCommand(command)) return [];
      return [
        {
          rule: `${toolName}(${command})`,
          scope: "exact",
          description: "this exact command",
        },
      ];
    }
    return [];
  }

  private workspaceRelative(path: string): string {
    const inside =
      path !== this.workspaceRoot &&
      isInsideWorkspace(path, this.workspaceRoot);
    return inside
      ? path.slice(this.workspaceRoot.replace(/\/$/, "").length + 1)
      : path;
  }
}
