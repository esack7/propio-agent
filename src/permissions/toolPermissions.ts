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
  type PolicyRequest,
  type ToolMetadata,
} from "../policy/index.js";
import { classifyGlobalInstallCommand } from "../tools/globalInstallGuard.js";
import { resolveToolPath } from "../tools/shared.js";
import type { ApprovalChannel } from "./approvalChannel.js";
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
  private channel?: ApprovalChannel;
  private enginePromise?: Promise<PolicyEngine>;
  private engine?: PolicyEngine;
  /** Grants restored before the engine finished loading. */
  private restoredGrants?: readonly string[];

  constructor(options: ToolPermissionsOptions = {}) {
    this.options = options;
    this.store = options.store ?? new InMemoryPermissionStore();
    this.toolWorkspaceRoot = options.workspaceRoot ?? process.cwd();
    this.workspaceRoot = fs.realpathSync(this.toolWorkspaceRoot);
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
    if (this.engine) await this.engine.reload();
    else await this.loadEngine();
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

  async authorize(
    input: ToolAuthorizationInput,
  ): Promise<AgentToolPolicyDecision> {
    const engine = await this.loadEngine();
    const request: PolicyRequest = {
      toolName: input.name,
      args: input.args as JsonObject,
      metadata: input.metadata,
      target: resolvePolicyTarget(input.name, input.args, {
        workspaceRoot: this.workspaceRoot,
        resolvePath: (rawPath) =>
          resolveToolPath(rawPath, this.toolWorkspaceRoot),
        mcpServerName: input.mcpServerName,
      }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.toolCallId === undefined
        ? {}
        : { toolCallId: input.toolCallId }),
    };
    const decision = engine.evaluate(request);
    const mode = engine.mode;
    if (decision.outcome !== "ask") {
      return decision.outcome === "allow"
        ? allowed(decision, mode)
        : denied(input.name, decision, mode);
    }

    // Only a mode default may be replaced by one of the application's own
    // approvals; an explicit ask rule always reaches the operator.
    const standing =
      decision.source === "mode"
        ? this.standingApproval(input, request)
        : undefined;
    if (standing) {
      engine.abandon(decision.request.id);
      return allowed(
        { ...standing, actor: "application", source: "mode" },
        mode,
      );
    }
    return await this.ask(engine, input, {
      ...decision.request,
      reason:
        decision.source === "mode"
          ? (this.globalInstallReason(request) ?? decision.request.reason)
          : decision.request.reason,
    });
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
   * compound command could chain anything after it, and a detached one runs
   * somewhere or with something the text does not show. Those ask as usual.
   */
  private isPlainGlobalInstall(request: PolicyRequest): boolean {
    const target = request.target;
    return (
      target?.kind === "command" &&
      target.detached !== true &&
      !isCompoundCommand(target.command) &&
      this.globalInstallReason(request) !== undefined
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
            "Run interactively to approve it, or start with --permissions accept-edits " +
            "(workspace edits) or --permissions bypass (every call).",
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
      const decision = await engine.answer(answer);
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
      workspaceRoot: this.workspaceRoot,
      homeDir: this.options.homeDir ?? os.homedir(),
      preset: this.options.preset,
      mode: this.options.mode,
    }).then(
      (engine) => {
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
