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
  literalPathPattern,
  parseRule,
  ruleMatches,
  type PolicyRule,
  type PolicyTarget,
  type RuleEffect,
} from "./rules.js";
import type {
  OwnerScope,
  PermissionSettings,
  PermissionSettingsChange,
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

type AllowDecision = "allow_once" | "allow_session" | "allow_always";

function allowDecision(value: unknown): AllowDecision {
  if (
    value === "allow_once" ||
    value === "allow_session" ||
    value === "allow_always"
  ) {
    return value;
  }
  throw new ApprovalAnswerError(`Unknown approval decision ${String(value)}`);
}

function operatorDenial(reason: string | undefined): PolicyDecision {
  return {
    outcome: "deny",
    rule: "approval:deny",
    reason: reason?.trim() || "Denied by the operator",
    actor: "user",
    source: "approval",
  };
}

function refusedApproval(denied: SourcedRule): PolicyDecision {
  return {
    outcome: "deny",
    rule: denied.rule.text,
    reason: `Matched ${denied.source} deny rule ${denied.rule.text}; the approval was not applied`,
    actor: "application",
    source: denied.source,
  };
}

function approvalDecision(
  decision: AllowDecision,
  grant: string | undefined,
): PolicyDecision {
  const reasons: Record<AllowDecision, string> = {
    allow_once: "Allowed once",
    allow_session: `Allowed for this session by ${grant}`,
    allow_always: `Always allowed by ${grant}`,
  };
  return {
    outcome: "allow",
    rule:
      decision === "allow_once"
        ? "approval:allow_once"
        : `approval:${decision}:${grant}`,
    reason: reasons[decision],
    actor: "user",
    source: "approval",
  };
}

function withoutRule(
  settings: PermissionSettings,
  text: string,
): PermissionSettings {
  const keep = (rules: readonly string[]) =>
    rules.filter((rule) => rule.trim() !== text);
  return {
    ...settings,
    allow: keep(settings.allow),
    ask: keep(settings.ask),
    deny: keep(settings.deny),
  };
}

/** An approved grant: added to allow, taken out of ask, never out of deny. */
function withGrant(
  settings: PermissionSettings,
  text: string,
): PermissionSettings {
  const keep = (rules: readonly string[]) =>
    rules.filter((rule) => rule.trim() !== text);
  return {
    ...settings,
    allow: [...keep(settings.allow), text],
    ask: keep(settings.ask),
  };
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
  private storeQueue: Promise<void> = Promise.resolve();
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
    this.preset = this.presetFor(settings);
    this.adopt(settings);
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
   * Apply an answer to a request this engine raised. The request is claimed
   * before anything is awaited, so a second answer cannot also decide it; it
   * is reopened if this answer fails. An allow is checked again against the
   * current deny rules, which may have changed while the request waited.
   */
  async answer(answer: ApprovalAnswer): Promise<PolicyDecision> {
    const requestId = answer?.requestId;
    const request = this.pending.get(requestId);
    if (!request) {
      throw new ApprovalAnswerError(
        `No pending approval request with id ${String(requestId)}`,
      );
    }
    this.pending.delete(requestId);
    try {
      return await this.decide(answer, request);
    } catch (error) {
      this.pending.set(requestId, request);
      throw error;
    }
  }

  private async decide(
    answer: ApprovalAnswer,
    request: PolicyRequest,
  ): Promise<PolicyDecision> {
    if (answer.decision === "deny") return operatorDenial(answer.reason);
    const decision = allowDecision(answer.decision);
    const grant =
      decision === "allow_once"
        ? undefined
        : this.grantableRule((answer as { rule?: unknown }).rule, request);

    // Pick up rules written while the request waited, by this engine or by
    // another engine for the same owner.
    await this.reload();
    if (decision === "allow_always" && grant) {
      const text = grant.text;
      await this.update((current) =>
        this.denyFor(request, current) ? current : withGrant(current, text),
      );
    }
    const denied = this.denyFor(request, this.settings);
    if (denied) return refusedApproval(denied);
    if (decision === "allow_session" && grant) {
      this.addSessionGrant(grant.text);
    }
    return approvalDecision(decision, grant?.text);
  }

  /** Read the owner's stored settings again, replacing the cached copy. */
  async reload(): Promise<void> {
    await this.serialized(async () =>
      this.adopt(await this.store.load(this.owner)),
    );
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

  /**
   * Add a rule to the owner's stored settings, removing it from the other
   * lists. This is an explicit edit, so it may move a rule out of `deny`.
   */
  async addRule(effect: RuleEffect, ruleText: string): Promise<void> {
    const text = this.checkedRule(ruleText).text;
    await this.update((current) => {
      const without = withoutRule(current, text);
      return { ...without, [effect]: [...without[effect], text] };
    });
  }

  async removeRule(ruleText: string): Promise<boolean> {
    const text = ruleText.trim();
    let removed = false;
    await this.update((current) => {
      const without = withoutRule(current, text);
      removed = EFFECTS.some(
        (effect) => without[effect].length !== current[effect].length,
      );
      return without;
    });
    return removed;
  }

  /** Select a preset for this instance; `persist` also stores it. */
  async setPreset(
    name: string,
    options: { persist?: boolean } = {},
  ): Promise<void> {
    if (!getPreset(name))
      throw new Error(`Unknown permission preset "${name}"`);
    if (options.persist) {
      await this.update((current) => ({ ...current, preset: name }));
    }
    this.presetOverride = name;
    this.modeOverride = undefined;
    this.adopt(this.settings);
  }

  setMode(mode: PermissionMode): void {
    this.modeOverride = mode;
  }

  /** Write through the store's atomic update, then use what it stored. */
  private async update(change: PermissionSettingsChange): Promise<void> {
    // A failed write throws here and leaves the rules in use unchanged.
    await this.serialized(async () =>
      this.adopt(await this.store.update(this.owner, change)),
    );
  }

  /**
   * Run this engine's store reads and writes one at a time, adopting each
   * result before the next starts. A read that began before a write can then
   * never finish after it and put back the settings the write replaced.
   */
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.storeQueue.then(operation, operation);
    this.storeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Validate everything before replacing any state, so bad settings change nothing. */
  private adopt(settings: PermissionSettings): void {
    const preset = this.presetFor(settings);
    const { userRules, presetRules } = this.rulesFor(settings, preset);
    this.settings = settings;
    this.preset = preset;
    this.userRules = userRules;
    this.presetRules = presetRules;
  }

  private presetFor(settings: PermissionSettings): PermissionPreset {
    const name = this.presetOverride ?? settings.preset ?? DEFAULT_PRESET_NAME;
    const preset = getPreset(name);
    if (!preset) throw new Error(`Unknown permission preset "${name}"`);
    return preset;
  }

  private rulesFor(
    settings: PermissionSettings,
    preset: PermissionPreset,
  ): { userRules: SourcedRule[]; presetRules: SourcedRule[] } {
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
    return {
      userRules: collect(settings, "user"),
      presetRules: collect(preset, "preset"),
    };
  }

  /** The first deny rule from the preset or the given settings that matches. */
  private denyFor(
    request: PolicyRequest,
    settings: PermissionSettings,
  ): SourcedRule | undefined {
    const { userRules, presetRules } = this.rulesFor(
      settings,
      this.presetFor(settings),
    );
    return [...presetRules, ...userRules].find(
      (candidate) =>
        candidate.effect === "deny" &&
        ruleMatches(
          candidate.rule,
          "deny",
          {
            toolName: request.toolName,
            capabilities: request.metadata.capabilities,
            target: request.target,
          },
          { workspaceRoot: this.workspaceRoot, homeDir: this.homeDir },
        ),
    );
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
      const shown = this.workspaceRelative(target.path);
      // A relative "~" or "~/..." would be read as the home directory.
      const path = /^~(\/|$)/.test(shown) ? target.path : shown;
      return [
        {
          rule: `${toolName}(${literalPathPattern(path)})`,
          scope: "exact",
          description: `${toolName} on ${shown}`,
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
