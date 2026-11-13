import * as fs from "fs";
import * as os from "os";
import type { AgentToolPolicyDecision } from "../agent-core/types.js";
import {
  InMemoryPermissionStore,
  PolicyEngine,
  isCompoundCommand,
  parseRule,
  type ApprovalRequest,
  type JsonObject,
  type OwnerScope,
  type PermissionMode,
  type PermissionStore,
  type PolicyDecision,
  type PolicyDescription,
  type PolicyRequest,
  type RuleEffect,
  type ToolMetadata,
} from "../policy/index.js";
import {
  classifyGlobalInstallCommand,
  isUnambiguousGlobalInstall,
} from "../tools/globalInstallGuard.js";
import { resolveToolPath } from "../tools/shared.js";
import type { ApprovalChannel } from "./approvalChannel.js";
import {
  createHostPathTranslator,
  sandboxMounts,
  unappliableHostRule,
  type SandboxPaths,
} from "./sandboxPaths.js";
import { resolvePolicyTarget } from "./targets.js";

/** The single owner of rules in the CLI. A server would pass its own. */
export const LOCAL_PERMISSION_OWNER: OwnerScope = "local";

export const NON_INTERACTIVE_RULE = "non_interactive";
export const GLOBAL_INSTALL_ENV_RULE = "env:PROPIO_ALLOW_GLOBAL_INSTALLS";

export interface ToolPermissionsOptions {
  readonly store?: PermissionStore;
  readonly owner?: OwnerScope;
  /** Defaults to the process working directory, as the built-in tools do. */
  readonly workspaceRoot?: string;
  readonly homeDir?: string;
  /** Overrides the stored preset for this process. */
  readonly preset?: string;
  readonly mode?: PermissionMode;
  /** Answers approval requests. Without one, every `ask` is denied. */
  readonly approvalChannel?: ApprovalChannel;
  /** Deprecated `PROPIO_ALLOW_GLOBAL_INSTALLS=1`: classified installs run unasked. */
  readonly allowGlobalInstallsWithoutPrompt?: boolean;
  /** Called after the preset, mode, rules, or session grants are edited. */
  readonly onChange?: () => void;
  /**
   * Set when running inside the sandbox, where the project is mounted under
   * another path than it has on the host. Rules are written in host terms,
   * so file paths are judged by their host names.
   */
  readonly sandbox?: SandboxPaths;
  /**
   * Why the store cannot save rules, or undefined when it can. Without this
   * saving is assumed to work.
   */
  readonly savingUnavailableReason?: () => Promise<string | undefined>;
}

/** The outcome of the most recent call that reached the rules. */
export interface LastPermissionDecision {
  readonly toolName: string;
  readonly allowed: boolean;
  readonly rule: string;
  readonly actor: AgentToolPolicyDecision["actor"];
  readonly reason?: string;
}

/** Everything `/permissions` shows. */
export interface PermissionsOverview extends PolicyDescription {
  readonly sessionGrants: readonly string[];
  /** Set when rules cannot be saved from here. */
  readonly savingUnavailableReason?: string;
  readonly lastDecision?: LastPermissionDecision;
}

export interface ToolAuthorizationInput {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly metadata: ToolMetadata;
  /** Set for an MCP tool: the configured name of its server. */
  readonly mcpServerName?: string;
  /**
   * Set when the agent's own plan or discover checks approved the call: a
   * read-only command, or a write to the approved plan file. Such a call
   * needs no prompt unless an explicit rule says otherwise.
   */
  readonly agentModeApproval?: string;
  readonly sessionId?: string;
  readonly toolCallId?: string;
  readonly signal?: AbortSignal;
}

function allowed(
  decision: Pick<PolicyDecision, "rule" | "reason" | "actor" | "source">,
  mode: PermissionMode,
): AgentToolPolicyDecision {
  return {
    allowed: true,
    actor: decision.actor,
    rule: decision.rule,
    reason: decision.reason,
    metadata: { permissionMode: mode, source: decision.source },
  };
}

function denied(
  toolName: string,
  decision: Pick<PolicyDecision, "rule" | "reason" | "actor" | "source">,
  mode: PermissionMode,
): AgentToolPolicyDecision {
  return {
    allowed: false,
    actor: decision.actor,
    rule: decision.rule,
    reason: `Permission denied for ${toolName}: ${decision.reason}`,
    metadata: { permissionMode: mode, source: decision.source },
  };
}

/**
 * What would let the call run without anyone to ask. An ask rule beats every
 * allow rule and every preset, so when one matched, only changing that rule
 * helps; allow rules and presets are suggested only for a mode default.
 */
function nonInteractiveGuidance(
  request: ApprovalRequest,
  askRule: string | undefined,
): string {
  if (askRule !== undefined) {
    return (
      "Run interactively to approve it, or change or remove the ask rule " +
      `${JSON.stringify(askRule)} (permissions.ask in ~/.propio/settings.json); ` +
      "an allow rule or a preset does not override an ask rule."
    );
  }
  const grant = request.suggestions[0]?.rule;
  return (
    "Run interactively to approve it, " +
    (grant
      ? `add ${JSON.stringify(grant)} to permissions.allow in ~/.propio/settings.json, `
      : "") +
    "or start with --permissions accept-edits (workspace edits) or " +
    "--permissions bypass (every call)."
  );
}

/**
 * Puts the policy engine in front of tool dispatch for one agent. It owns
 * what policy must not know: how tool arguments become a target, the
 * global-install classifier, the agent's plan and discover approvals, and
 * the channel an approval request is put to.
 */
export class ToolPermissions {
  private readonly options: ToolPermissionsOptions;
  private readonly store: PermissionStore;
  private readonly workspaceRoot: string;
  private readonly toolWorkspaceRoot: string;
  private readonly translatePath?: (resolvedPath: string) => string;
  private channel?: ApprovalChannel;
  private enginePromise?: Promise<PolicyEngine>;
  private engine?: PolicyEngine;
  /** Grants restored before the engine finished loading. */
  private restoredGrants?: readonly string[];
  private lastDecision?: LastPermissionDecision;

  constructor(options: ToolPermissionsOptions = {}) {
    this.options = options;
    this.store = options.store ?? new InMemoryPermissionStore();
    this.toolWorkspaceRoot = options.workspaceRoot ?? process.cwd();
    this.workspaceRoot = fs.realpathSync(this.toolWorkspaceRoot);
    const hostPaths = options.sandbox?.hostPaths;
    this.translatePath = hostPaths
      ? createHostPathTranslator(
          sandboxMounts(
            this.workspaceRoot,
            hostPaths,
            options.sandbox?.configMount,
          ),
        )
      : undefined;
    this.channel = options.approvalChannel;
  }

  setApprovalChannel(channel: ApprovalChannel | undefined): void {
    this.channel = channel;
  }

  hasApprovalChannel(): boolean {
    return this.channel !== undefined;
  }

  /** The preset and mode in force, once the stored settings have loaded. */
  describe(): { preset: string; mode: PermissionMode } | undefined {
    if (!this.engine) return undefined;
    const { preset, mode } = this.engine.describe();
    return { preset, mode };
  }

  /** Read the stored rules again; called once at the start of each turn. */
  async refresh(): Promise<void> {
    if (!this.engine) {
      await this.loadEngine();
      return;
    }
    await this.engine.reload();
    this.assertRulesApply(this.engine);
  }

  /**
   * In a sandbox that was not told the host's paths, a deny or ask rule
   * written with one would match nothing. Stop rather than run without it.
   */
  private assertRulesApply(engine: PolicyEngine): void {
    if (!this.options.sandbox || this.options.sandbox.hostPaths) return;
    const problem = unappliableHostRule(engine.describe().rules);
    if (problem !== undefined) throw new Error(problem);
  }

  listSessionGrants(): readonly string[] {
    return this.engine?.listSessionGrants() ?? [...(this.restoredGrants ?? [])];
  }

  /** Replace the session's grants, as on resume. A grant that cannot be read throws. */
  restoreSessionGrants(ruleTexts: readonly string[] = []): void {
    for (const text of ruleTexts) parseRule(text);
    if (this.engine) this.engine.restoreSessionGrants(ruleTexts);
    else this.restoredGrants = [...ruleTexts];
  }

  /** The preset, mode, rules by source, session grants, and last decision. */
  async overview(): Promise<PermissionsOverview> {
    const engine = await this.loadEngine();
    const unavailable = await this.savingUnavailableReason();
    return {
      ...engine.describe(),
      sessionGrants: engine.listSessionGrants(),
      ...(unavailable === undefined
        ? {}
        : { savingUnavailableReason: unavailable }),
      ...(this.lastDecision ? { lastDecision: this.lastDecision } : {}),
    };
  }

  /** Why an always-allow or a rule edit cannot be saved; undefined when it can. */
  async savingUnavailableReason(): Promise<string | undefined> {
    return await this.options.savingUnavailableReason?.();
  }

  /** Store a rule for the owner, moving it out of the other lists. */
  async addRule(effect: RuleEffect, ruleText: string): Promise<void> {
    await (await this.loadEngine()).addRule(effect, ruleText);
    this.options.onChange?.();
  }

  /** Remove a stored rule from whichever list holds it. */
  async removeRule(ruleText: string): Promise<boolean> {
    const removed = await (await this.loadEngine()).removeRule(ruleText);
    if (removed) this.options.onChange?.();
    return removed;
  }

  async revokeSessionGrant(ruleText: string): Promise<boolean> {
    const revoked = (await this.loadEngine()).revokeSessionGrant(ruleText);
    if (revoked) this.options.onChange?.();
    return revoked;
  }

  /** Select a preset for this session; the stored preset is left alone. */
  async setPreset(name: string): Promise<void> {
    await (await this.loadEngine()).setPreset(name);
    this.options.onChange?.();
  }

  /** Override the preset's mode for this session. */
  async setMode(mode: PermissionMode): Promise<void> {
    (await this.loadEngine()).setMode(mode);
    this.options.onChange?.();
  }

  async authorize(
    input: ToolAuthorizationInput,
  ): Promise<AgentToolPolicyDecision> {
    const decision = await this.decide(input);
    this.lastDecision = {
      toolName: input.name,
      allowed: decision.allowed,
      rule: decision.rule,
      actor: decision.actor,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    };
    return decision;
  }

  private async decide(
    input: ToolAuthorizationInput,
  ): Promise<AgentToolPolicyDecision> {
    const engine = await this.loadEngine();
    const request = this.policyRequest(input);
    const decision = engine.evaluate(request);
    const mode = engine.mode;
    if (decision.outcome !== "ask") {
      return decision.outcome === "allow"
        ? allowed(decision, mode)
        : denied(input.name, decision, mode);
    }
    // An explicit ask rule always reaches the operator.
    if (decision.source !== "mode") {
      return await this.ask(engine, input, decision.request, decision.rule);
    }
    // Only a mode default may be replaced by one of the application's own
    // approvals, or explained by the global-install classifier.
    const standing = this.standingApproval(input, request);
    if (standing) {
      engine.abandon(decision.request.id);
      return allowed(
        { ...standing, actor: "application", source: "mode" },
        mode,
      );
    }
    return await this.ask(
      engine,
      input,
      {
        ...decision.request,
        reason: this.globalInstallReason(request) ?? decision.request.reason,
      },
      undefined,
    );
  }

  private policyRequest(input: ToolAuthorizationInput): PolicyRequest {
    return {
      toolName: input.name,
      args: input.args as JsonObject,
      metadata: input.metadata,
      target: resolvePolicyTarget(input.name, input.args, {
        workspaceRoot: this.workspaceRoot,
        resolvePath: (rawPath) =>
          resolveToolPath(rawPath, this.toolWorkspaceRoot),
        mcpServerName: input.mcpServerName,
        translatePath: this.translatePath,
      }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.toolCallId === undefined
        ? {}
        : { toolCallId: input.toolCallId }),
    };
  }

  private standingApproval(
    input: ToolAuthorizationInput,
    request: PolicyRequest,
  ): { rule: string; reason: string } | undefined {
    if (input.agentModeApproval !== undefined) {
      return {
        rule: `agent_mode:${input.agentModeApproval}`,
        reason: `Approved by the ${input.agentModeApproval} mode checks`,
      };
    }
    if (
      this.options.allowGlobalInstallsWithoutPrompt === true &&
      this.isPlainGlobalInstall(request)
    ) {
      return {
        rule: GLOBAL_INSTALL_ENV_RULE,
        reason:
          "Global installs are allowed without a prompt by PROPIO_ALLOW_GLOBAL_INSTALLS (deprecated)",
      };
    }
    return undefined;
  }

  /**
   * The deprecated setting approves an install, not a shell invocation: a
   * compound command could chain anything after it, a detached one runs
   * somewhere or with something the text does not show, and a command the
   * strict recognizer cannot place as an install subcommand may be something
   * else. Those ask as usual.
   */
  private isPlainGlobalInstall(request: PolicyRequest): boolean {
    const target = request.target;
    return (
      target?.kind === "command" &&
      target.detached !== true &&
      !isCompoundCommand(target.command) &&
      isUnambiguousGlobalInstall(target.command)
    );
  }

  private globalInstallReason(request: PolicyRequest): string | undefined {
    if (request.target?.kind !== "command") return undefined;
    const classification = classifyGlobalInstallCommand(request.target.command);
    if (!classification.matched) return undefined;
    return (
      classification.reason ??
      "This command would install software globally on the system."
    );
  }

  private async ask(
    engine: PolicyEngine,
    input: ToolAuthorizationInput,
    request: ApprovalRequest,
    /** The ask rule that matched, when a rule and not the mode default asked. */
    askRule: string | undefined,
  ): Promise<AgentToolPolicyDecision> {
    const channel = this.channel;
    if (!channel) {
      engine.abandon(request.id);
      return denied(
        input.name,
        {
          rule: NON_INTERACTIVE_RULE,
          reason:
            `approval required (${request.reason}); not available in non-interactive mode. ` +
            nonInteractiveGuidance(request, askRule),
          actor: "application",
          source: "mode",
        },
        engine.mode,
      );
    }
    try {
      const answer = await channel.request(request, input.signal);
      if (answer?.requestId !== request.id) {
        throw new Error(
          `Approval answer is for request ${String(answer?.requestId)}, not ${request.id}`,
        );
      }
      // Stopped while the question was open: an answer that arrives anyway
      // must not run the call or record a grant.
      input.signal?.throwIfAborted();
      // The answer may wait on the settings lock; a turn cancelled meanwhile
      // must not leave a saved or session grant behind.
      const decision = await engine.answer(answer, { signal: input.signal });
      return decision.outcome === "allow"
        ? allowed(decision, engine.mode)
        : denied(input.name, decision, engine.mode);
    } catch (error) {
      // Anything but a clean answer leaves the call refused.
      engine.abandon(request.id);
      throw error;
    }
  }

  private loadEngine(): Promise<PolicyEngine> {
    this.enginePromise ??= PolicyEngine.create({
      store: this.store,
      owner: this.options.owner ?? LOCAL_PERMISSION_OWNER,
      // In the sandbox the engine reasons in host paths throughout, so host
      // rules, grants, and what the operator is shown all agree.
      workspaceRoot:
        this.options.sandbox?.hostPaths?.workspace ?? this.workspaceRoot,
      homeDir:
        this.options.sandbox?.hostPaths?.home ??
        this.options.homeDir ??
        os.homedir(),
      preset: this.options.preset,
      mode: this.options.mode,
    }).then(
      (engine) => {
        this.assertRulesApply(engine);
        if (this.restoredGrants) {
          engine.restoreSessionGrants(this.restoredGrants);
          this.restoredGrants = undefined;
        }
        this.engine = engine;
        return engine;
      },
      (error) => {
        // Let the next call try again, for example after the rules are fixed.
        this.enginePromise = undefined;
        throw error;
      },
    );
    return this.enginePromise;
  }
}
