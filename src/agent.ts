import {
  type LLMProvider,
  type ChatMessage,
  type ChatTool,
  type ProviderDiagnosticEvent,
  ProviderError,
  ProviderAuthenticationError,
  ProviderModelNotFoundError,
  type ProvidersConfig,
  type ProviderConfig,
  createProvider,
  type ProviderModelSelection,
  resolveProvider,
  resolveModelKey,
} from "@propio-ai/providers";
import * as fs from "fs";
import * as os from "os";
import { randomUUID } from "crypto";
import { loadRuntimeConfig, RuntimeConfig } from "./config/runtimeConfig.js";
import { loadProvidersConfig } from "./config/providersConfig.js";
import { ToolRegistry } from "./tools/registry.js";
import { createDefaultToolRegistry } from "./tools/factory.js";
import type { BashGlobalInstallGateConfig } from "./tools/bash.js";
import type { GlobalInstallApprovalRequest } from "./tools/globalInstallGuard.js";
import { PresentedTool } from "./tools/interface.js";
import type { ToolSummary } from "./tools/registry.js";
import type {
  ToolExecutionResult,
  ToolExecutionStatus,
} from "./tools/types.js";
import { persistToolOutput } from "./tools/outputPersistence.js";
import type { AgentDiagnosticEvent } from "./diagnostics.js";
import {
  compileSystemPrompt,
  DEFAULT_CORE_IDENTITY,
  joinSections,
} from "./prompt/compileSystemPrompt.js";
import { SystemPromptSectionRegistry } from "./prompt/systemPromptSectionRegistry.js";
import {
  AgentRuntime,
  type AgentVisibilityEvent as RuntimeEvent,
  type AgentLifecycleEvent,
  type AgentStreamOptions as RuntimeStreamOptions,
  type TurnReasoningSummary,
  type PromptPlanSnapshot,
  type PromptSubmission,
} from "./agent-core/index.js";
import { buildSystemPromptContext } from "./prompt/systemPromptContext.js";
import { ContextManager } from "./context/contextManager.js";
import {
  ArtifactToolResult,
  PromptBudgetPolicy,
  DEFAULT_BUDGET_POLICY,
  SummaryPolicy,
  DEFAULT_SUMMARY_POLICY,
  PromptPlan,
  ConversationState,
  PinnedMemoryRecord,
  PinFactInput,
  UpdateMemoryInput,
} from "./context/types.js";
import { SummaryManager } from "./context/summaryManager.js";
import {
  serializeSession,
  parseSession,
  restoreConversationState,
  SessionMetadata,
} from "./context/persistence.js";
import {
  getDefaultSessionsDir,
  writeInProgressMarker,
  clearInProgressMarker,
  InProgressMarker,
} from "./sessions/sessionHistory.js";
import {
  removeEmptyScratchpadDir,
  resolveScratchpadDir,
} from "./scratchpad/scratchpad.js";
import { isSafeSessionId } from "./sessions/sessionId.js";
import { McpManager } from "./mcp/manager.js";
import type {
  McpConfigFile,
  McpServerDetail,
  McpServerSummary,
  McpToolSummary,
} from "./mcp/types.js";
import { loadLocalSkills } from "./skills/loader.js";
import type {
  InvokedSkillRecord,
  Skill,
  SkillLoadDiagnostic,
  SkillInvocationOptions,
  SkillInvocationScope,
} from "./skills/index.js";
import { SkillRegistry, renderSkillDiscoveryBlock } from "./skills/index.js";
import { createMissingSkillError } from "./skills/shared.js";
import { normalizeToolPath } from "./tools/shared.js";
import { AttachmentResolver } from "./fileSearch/attachmentResolver.js";
import { inlineSyntheticMentionPairs } from "./fileSearch/syntheticMention.js";
import { resolveEffectiveToolAllowlist } from "./modes/policies.js";
import { checkBashAllowedForMode } from "./modes/bashPolicy.js";
import {
  allocatePlanFile,
  extractProposedPlanContent,
  isPlanFilePath,
  writePlanFile,
} from "./modes/planFile.js";
import {
  composeExtraUserInstruction,
  EXECUTE_SWITCH_REMINDER_PLAN_CONTENT_MAX_CHARS,
  getExecuteSwitchReminder,
  getModeReminder,
} from "./modes/prompts.js";
import {
  AGENT_MODE_CYCLE,
  getApprovedPlanPersistenceFields,
  resolveImportedPlanState,
  type AgentMode,
  type AgentModeState,
} from "./modes/types.js";

export type { AgentMode, AgentModeState };

type RuntimeToolResultEvent = Extract<
  RuntimeEvent,
  { type: "tool_finished" | "tool_failed" }
>;
type CliToolResultEvent<T> = T extends RuntimeToolResultEvent
  ? Omit<T, "result" | "args" | "status">
  : never;
export type AgentVisibilityEvent =
  | Exclude<RuntimeEvent, AgentLifecycleEvent | RuntimeToolResultEvent>
  | CliToolResultEvent<RuntimeToolResultEvent>
  | { type: "mode_changed"; mode: AgentMode; planFilePath?: string }
  | { type: "plan_saved"; planFilePath: string };
type AgentEventOptions = {
  readonly onEvent?: (event: AgentVisibilityEvent) => void;
  readonly requestReasoning?: boolean;
};
type AgentStreamOptions = Omit<RuntimeStreamOptions, "onEvent"> &
  AgentEventOptions & {
    /** @deprecated Use onEvent with tool_started instead. */
    readonly onToolStart?: (toolName: string) => void;
    /** @deprecated Use onEvent with tool_finished/tool_failed instead. */
    readonly onToolEnd?: (
      toolName: string,
      result: string,
      status: ToolExecutionStatus,
    ) => void;
  };
export type {
  TurnReasoningSummary,
  PromptPlanSnapshot,
} from "./agent-core/index.js";

function isRuntimeOnlyEvent(event: RuntimeEvent): event is AgentLifecycleEvent {
  return [
    "turn_started",
    "turn_completed",
    "turn_cancelled",
    "turn_failed",
    "assistant_text",
  ].includes(event.type);
}

export class Agent {
  private provider!: LLMProvider;
  private model!: string;
  private resolvedProviderConfig!: ProviderConfig;
  private contextManager: ContextManager;
  private baseRules: string;
  private agentsMdContent: string;
  private systemPromptRegistry: SystemPromptSectionRegistry;
  private toolRegistry: ToolRegistry;
  private mcpManager: McpManager;
  private providersConfig: ProvidersConfig;
  private diagnosticsEnabled: boolean;
  private diagnosticsListener?: (event: AgentDiagnosticEvent) => void;
  private lastTurnReasoningSummary: TurnReasoningSummary | null = null;
  private lastPromptPlanSnapshot: PromptPlanSnapshot | null = null;
  private summaryManager: SummaryManager;
  private summaryPolicy: SummaryPolicy;
  private summaryRefreshRunning = false;
  private summaryDirty = false;
  private summaryGeneration = 0;
  private skillRegistry?: SkillRegistry;
  private skillDiagnostics: SkillLoadDiagnostic[] = [];
  private attachmentResolver?: AttachmentResolver;
  private readonly skillContext: {
    readonly cwd: string;
    readonly homeDir: string;
  };
  private readonly sessionId: string;
  private readonly runtimeConfig: RuntimeConfig;
  private readonly bashGlobalInstallGate: BashGlobalInstallGateConfig;
  private sessionsDir: string | null = null;
  private readonly configuredSessionsDir?: string;
  private turnScratchpadDir: string | undefined;
  private pendingToolResultBytes = 0;
  private modeState: AgentModeState = { mode: "execute" };
  private pendingExecuteSwitchReminder = false;
  private latestPlanModeAssistantDraft?: string;
  private planDraftSearchStartTurnIndex?: number;

  constructor(
    options: {
      providersConfig: ProvidersConfig | string;
      providerName?: string;
      modelKey?: string;
      mcpConfig?: McpConfigFile;
      mcpConfigPath?: string;
      systemPrompt?: string;
      agentsMdContent?: string;
      cwd?: string;
      homeDir?: string;
      /** Override ~/.propio/sessions/<hash> (tests). */
      sessionsDir?: string;
      diagnosticsEnabled?: boolean;
      onDiagnosticEvent?: (event: AgentDiagnosticEvent) => void;
      runtimeConfig?: RuntimeConfig;
    } = {} as any,
  ) {
    if (!options.providersConfig) {
      throw new Error(
        "Provider configuration is required. Please provide a providersConfig option with provider settings.",
      );
    }

    this.baseRules = options.systemPrompt ?? DEFAULT_CORE_IDENTITY;
    this.agentsMdContent = options.agentsMdContent ?? "";
    this.systemPromptRegistry = new SystemPromptSectionRegistry();

    this.providersConfig = Agent.normalizeProvidersConfig(
      options.providersConfig,
    );
    this.diagnosticsEnabled = options.diagnosticsEnabled ?? false;
    this.diagnosticsListener = options.onDiagnosticEvent;
    this.skillContext = {
      cwd: options.cwd ?? process.cwd(),
      homeDir: options.homeDir ?? os.homedir(),
    };
    this.configuredSessionsDir = options.sessionsDir;

    this.sessionId = randomUUID();
    this.runtimeConfig = options.runtimeConfig ?? loadRuntimeConfig();
    this.bashGlobalInstallGate = {
      allowGlobalInstallsWithoutPrompt:
        this.runtimeConfig.allowGlobalInstallsWithoutPrompt,
    };
    this.initializeProvider(
      this.providersConfig,
      options.providerName,
      options.modelKey,
    );

    this.contextManager = new ContextManager({
      toolResultSummaryMaxChars: this.runtimeConfig.toolResultSummaryMaxChars,
      rehydrationMaxChars: this.runtimeConfig.rehydrationMaxChars,
      pinnedMemoryMaxContentLength:
        this.runtimeConfig.pinnedMemoryMaxContentLength,
    });
    this.toolRegistry = createDefaultToolRegistry({
      runtimeConfig: this.runtimeConfig,
      bashGlobalInstallGate: this.bashGlobalInstallGate,
      skillToolInvoker: {
        invokeSkill: async (
          name: string,
          argumentsText: string | undefined,
          options:
            | {
                readonly source?: "model";
              }
            | undefined,
        ) => {
          await this.invokeSkill(name, argumentsText, options);
          return `Activated skill ${name}.`;
        },
      },
    });
    this.mcpManager = new McpManager(Agent.buildMcpManagerOptions(options));
    this.summaryManager = new SummaryManager();
    this.summaryPolicy = {
      ...DEFAULT_SUMMARY_POLICY,
      summaryTargetTokens: this.runtimeConfig.rollingSummaryTargetTokens,
    };
  }

  private static normalizeProvidersConfig(
    config: ProvidersConfig | string,
  ): ProvidersConfig {
    if (typeof config === "string") {
      return loadProvidersConfig(config);
    }
    return config;
  }

  private initializeProvider(
    config: ProvidersConfig,
    providerName: string | undefined,
    modelKey: string | undefined,
  ): void {
    const resolvedProvider = resolveProvider(config, providerName);
    const resolvedModelKey = resolveModelKey(resolvedProvider, modelKey);
    this.resolvedProviderConfig = resolvedProvider;
    this.provider = createProvider(
      resolvedProvider,
      resolvedModelKey,
      this.diagnosticsEnabled ? this.forwardProviderDiagnostic : undefined,
      this.diagnosticsEnabled,
      {
        maxRetries: this.runtimeConfig.maxRetries,
        consecutive529Limit: this.runtimeConfig.consecutive529FallbackLimit,
      },
    );
    this.model = resolvedModelKey;
  }

  private static buildMcpManagerOptions(options: {
    mcpConfig?: McpConfigFile;
    mcpConfigPath?: string;
  }): { config?: McpConfigFile; configPath?: string } {
    return {
      ...(options.mcpConfig ? { config: options.mcpConfig } : {}),
      ...(options.mcpConfigPath ? { configPath: options.mcpConfigPath } : {}),
    };
  }

  async initialize(): Promise<void> {
    await this.mcpManager.initialize();
  }

  async close(): Promise<void> {
    await this.mcpManager.close();
  }

  private emitDiagnostic(event: AgentDiagnosticEvent): void {
    if (!this.diagnosticsEnabled || !this.diagnosticsListener) {
      return;
    }
    this.diagnosticsListener(event);
  }

  /**
   * Forward provider-owned diagnostic events into the agent diagnostics
   * stream. ProviderDiagnosticEvent is structurally assignable to the
   * provider_retry member of AgentDiagnosticEvent.
   */
  private readonly forwardProviderDiagnostic = (
    event: ProviderDiagnosticEvent,
  ): void => {
    this.diagnosticsListener?.(event);
  };

  private emitVisibilityEvent(
    options: AgentEventOptions | undefined,
    event: AgentVisibilityEvent,
  ): void {
    options?.onEvent?.(event);
  }

  private describeToolInvocation(
    toolName: string,
    args: Record<string, unknown>,
  ): string {
    if (this.toolRegistry.hasTool(toolName)) {
      return this.toolRegistry.describeToolInvocation(toolName, args);
    }

    return this.mcpManager.describeToolInvocation(toolName, args) || toolName;
  }

  private getMergedToolSchemas(allowedTools?: ReadonlySet<string>): ChatTool[] {
    const schemas = new Map<string, ChatTool>();

    for (const schema of this.toolRegistry.getEnabledSchemas()) {
      if (allowedTools && !allowedTools.has(schema.function.name)) {
        continue;
      }
      schemas.set(schema.function.name, schema);
    }

    for (const schema of this.mcpManager.getConnectedToolSchemas()) {
      if (allowedTools && !allowedTools.has(schema.function.name)) {
        continue;
      }
      if (!schemas.has(schema.function.name)) {
        schemas.set(schema.function.name, schema);
      }
    }

    return Array.from(schemas.values());
  }

  // fallow-ignore-next-line complexity
  private async executeToolWithStatus(
    name: string,
    args: Record<string, unknown>,
    allowedTools?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (allowedTools && !allowedTools.has(name)) {
      return {
        status: "tool_disabled",
        content: `Tool not available in the current mode or skill scope: ${name}`,
      };
    }

    const mode = this.modeState.mode;
    if (mode === "plan" && (name === "write" || name === "edit")) {
      if (!this.modeState.planSaveApproved || !this.modeState.planFilePath) {
        return {
          status: "tool_disabled",
          content:
            "In Plan mode, file writes require an approved plan save (/plan save) before write/edit is enabled.",
        };
      }
      if (!isPlanFilePath(args.path, this.modeState.planFilePath)) {
        return {
          status: "tool_disabled",
          content: `In Plan mode, write/edit is only allowed for the approved plan file (${this.modeState.planFilePath})`,
        };
      }
    }

    if (name === "bash" && (mode === "plan" || mode === "discover")) {
      const command =
        typeof args.command === "string"
          ? args.command
          : String(args.command ?? "");
      const bashPolicy = checkBashAllowedForMode(command, mode);
      if (!bashPolicy.allowed) {
        return {
          status: "tool_disabled",
          content: bashPolicy.reason ?? "Command not allowed in this mode",
        };
      }
    }

    if (this.toolRegistry.hasTool(name)) {
      return await this.toolRegistry.executeWithStatus(name, args, { signal });
    }

    if (this.mcpManager.hasTool(name)) {
      return await this.mcpManager.executeToolWithStatus(name, args);
    }

    return { status: "tool_not_found", content: `Tool not found: ${name}` };
  }

  switchProvider(providerName: string, modelKey?: string): void {
    const resolvedProvider = resolveProvider(
      this.providersConfig,
      providerName,
    );
    const resolvedModelKey = resolveModelKey(resolvedProvider, modelKey);
    const newProvider = createProvider(
      resolvedProvider,
      resolvedModelKey,
      this.diagnosticsEnabled ? this.forwardProviderDiagnostic : undefined,
      this.diagnosticsEnabled,
      {
        maxRetries: this.runtimeConfig.maxRetries,
        consecutive529Limit: this.runtimeConfig.consecutive529FallbackLimit,
      },
    );

    this.resolvedProviderConfig = resolvedProvider;
    this.provider = newProvider;
    this.model = resolvedModelKey;
  }

  private getSkillRegistry(): SkillRegistry {
    if (!this.skillRegistry) {
      const { registry, diagnostics } = loadLocalSkills(this.skillContext);
      this.skillRegistry = registry;
      this.skillDiagnostics = diagnostics.slice();
    }
    return this.skillRegistry;
  }

  listSkills(): ReadonlyArray<Skill> {
    return this.getSkillRegistry().list();
  }

  listUserInvocableSkills(): ReadonlyArray<Skill> {
    return this.getSkillRegistry().listUserInvocable();
  }

  // fallow-ignore-next-line unused-class-member
  listModelInvocableSkills(): ReadonlyArray<Skill> {
    return this.getSkillRegistry().listModelInvocable();
  }

  getSkillDiagnostics(): ReadonlyArray<SkillLoadDiagnostic> {
    this.skillDiagnostics = this.getSkillRegistry().getDiagnostics().slice();
    return this.skillDiagnostics.slice();
  }

  refreshSkills(): SkillLoadDiagnostic[] {
    const diagnostics = this.getSkillRegistry().refresh();
    this.skillDiagnostics = diagnostics.slice();
    return diagnostics.slice();
  }

  recordSkillFileTouch(paths: readonly string[]): ReadonlyArray<Skill> {
    return this.getSkillRegistry().recordFileTouch(paths);
  }

  private getAttachmentResolver(): AttachmentResolver {
    if (!this.attachmentResolver) {
      this.attachmentResolver = new AttachmentResolver({
        cwd: this.skillContext.cwd,
        homeDir: this.skillContext.homeDir,
      });
    }

    return this.attachmentResolver;
  }

  private async attachFileMentions(userMessage: string): Promise<void> {
    const attachments =
      await this.getAttachmentResolver().resolveText(userMessage);
    if (attachments.length === 0) {
      return;
    }

    this.contextManager.commitAssistantResponse(
      "",
      attachments.map((attachment) => attachment.toolCall),
    );
    this.contextManager.recordToolResults(
      attachments.map((attachment) => attachment.toolResult),
    );
  }

  private getActiveSkillScopes(): SkillInvocationScope[] {
    const invokedSkills =
      this.contextManager.getConversationState().invokedSkills ?? [];
    return invokedSkills.map((record) => ({
      ...record.scope,
      ...(record.scope.allowedTools
        ? { allowedTools: [...record.scope.allowedTools] }
        : {}),
      ...(record.scope.warnings
        ? { warnings: [...record.scope.warnings] }
        : {}),
    }));
  }

  private recordSkillTouchFromToolArgs(
    toolName: string,
    args: Record<string, unknown>,
  ): void {
    if (toolName !== "read" && toolName !== "write" && toolName !== "edit") {
      return;
    }
    const touchedPaths = this.extractPathsFromToolArgs(args);
    if (touchedPaths.length > 0) {
      this.recordSkillFileTouch(touchedPaths.map(normalizeToolPath));
    }
  }

  private extractPathsFromToolArgs(args: Record<string, unknown>): string[] {
    const paths: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" && /path/i.test(key)) {
        paths.push(value);
      }
      if (Array.isArray(value) && /paths?/i.test(key)) {
        for (const entry of value) {
          if (typeof entry === "string" && entry.trim().length > 0) {
            paths.push(entry);
          }
        }
      }
    }
    return paths;
  }

  async invokeSkill(
    name: string,
    argumentsText?: string,
    options?: SkillInvocationOptions,
  ): Promise<string> {
    const registry = this.getSkillRegistry();
    const skill = registry.get(name);
    if (!skill) {
      throw createMissingSkillError(name, registry.list());
    }

    const source = options?.source ?? "user";
    this.validateSkillForInvocation(skill, source);

    const requestedModel = skill.model;
    const requestedEffort = skill.effort;
    const appliedModel =
      requestedModel && requestedModel === this.model ? this.model : undefined;
    const materializationWarnings: string[] = [];

    const content = registry.materialize(
      skill.name,
      { arguments: argumentsText },
      {
        onWarning: (message) => {
          materializationWarnings.push(message);
        },
      },
    );
    const warnings = this.collectSkillWarnings(
      requestedModel,
      appliedModel,
      requestedEffort,
    );
    const combinedWarnings =
      warnings.length > 0 || materializationWarnings.length > 0
        ? [...warnings, ...materializationWarnings]
        : undefined;

    const scope = this.buildSkillScope(
      skill,
      source,
      requestedModel,
      requestedEffort,
      appliedModel,
      combinedWarnings,
    );

    const invocationRecord: InvokedSkillRecord = {
      name: skill.name,
      source: skill.source,
      skillRoot: skill.skillRoot,
      skillFile: skill.skillFile,
      ...(argumentsText ? { arguments: argumentsText } : {}),
      content,
      invokedAt: new Date().toISOString(),
      scope,
    };

    this.contextManager.recordInvokedSkill(invocationRecord);
    return invocationRecord.content;
  }

  private validateSkillForInvocation(
    skill: Skill,
    source: "user" | "model",
  ): void {
    if (source === "user" && skill.userInvocable === false) {
      throw new Error(`Skill is not user-invocable: ${skill.name}`);
    }
    if (source === "model" && skill.disableModelInvocation === true) {
      throw new Error(`Skill is not model-invocable: ${skill.name}`);
    }
    if (skill.context === "fork") {
      throw new Error(
        `Skill "${skill.name}" requests forked execution, which is not supported yet.`,
      );
    }
  }

  private collectSkillWarnings(
    requestedModel: string | undefined,
    appliedModel: string | undefined,
    requestedEffort: string | undefined,
  ): string[] {
    const warnings: string[] = [];
    if (requestedModel && !appliedModel) {
      warnings.push(
        `Requested model "${requestedModel}" was not applied; continuing with ${this.provider.name}/${this.model}.`,
      );
    }
    if (requestedEffort) {
      warnings.push(
        `Requested effort "${requestedEffort}" was recorded but not applied by the current provider.`,
      );
    }
    return warnings;
  }

  private buildSkillScope(
    skill: Skill,
    source: "user" | "model",
    requestedModel: string | undefined,
    requestedEffort: string | undefined,
    appliedModel: string | undefined,
    combinedWarnings: string[] | undefined,
  ): SkillInvocationScope {
    return {
      invocationSource: source,
      skillName: skill.name,
      skillRoot: skill.skillRoot,
      skillFile: skill.skillFile,
      ...(skill.allowedTools ? { allowedTools: [...skill.allowedTools] } : {}),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(requestedEffort ? { effort: requestedEffort } : {}),
      ...(appliedModel ? { appliedModel } : {}),
      ...(combinedWarnings ? { warnings: combinedWarnings } : {}),
    };
  }

  private composeSkillDiscoveryBlock(): string {
    return renderSkillDiscoveryBlock(
      this.getSkillRegistry().listModelInvocable(),
    );
  }

  private collectEnabledToolNames(
    allowedTools?: ReadonlySet<string>,
  ): string[] {
    return this.getMergedToolSchemas(allowedTools).map(
      (schema) => schema.function.name,
    );
  }

  private compileSystemCore(allowedTools?: ReadonlySet<string>): {
    core: string;
    runtimeContextOverflowBlock?: string;
  } {
    const ctx = buildSystemPromptContext({
      cwd: this.skillContext.cwd,
      enabledToolNames: this.collectEnabledToolNames(allowedTools),
      scratchpadDir: this.turnScratchpadDir,
    });
    const { compiled, runtimeContextOverflowBlock } = compileSystemPrompt(
      ctx,
      {
        baseRules: this.baseRules,
        agentsMdContent: this.agentsMdContent,
        modeContext: {
          mode: this.modeState.mode,
          planFilePath: this.modeState.planFilePath,
          planSaveApproved: this.modeState.planSaveApproved ?? false,
        },
      },
      this.systemPromptRegistry,
    );
    return {
      core: joinSections(compiled),
      runtimeContextOverflowBlock,
    };
  }

  private buildEffectiveSystemPrompt(allowedTools?: ReadonlySet<string>): {
    systemPrompt: string;
    runtimeContextOverflowBlock?: string;
  } {
    const { core, runtimeContextOverflowBlock } =
      this.compileSystemCore(allowedTools);
    const discoveryBlock =
      this.modeState.mode === "execute"
        ? this.composeSkillDiscoveryBlock()
        : "";
    const systemPrompt = discoveryBlock ? `${core}\n\n${discoveryBlock}` : core;

    return { systemPrompt, runtimeContextOverflowBlock };
  }

  private getEnabledBuiltinNames(): string[] {
    return this.toolRegistry
      .getEnabledSchemas()
      .map((schema) => schema.function.name);
  }

  private getConnectedMcpToolNames(): string[] {
    return this.mcpManager
      .getConnectedToolSchemas()
      .map((schema) => schema.function.name);
  }

  private resolveAllowedTools(
    skillScopes: ReadonlyArray<SkillInvocationScope>,
  ): ReadonlySet<string> | undefined {
    return resolveEffectiveToolAllowlist({
      mode: this.modeState.mode,
      skillScopes,
      enabledBuiltinNames: this.getEnabledBuiltinNames(),
      connectedMcpToolNames: this.getConnectedMcpToolNames(),
      planFilePath: this.modeState.planFilePath,
      planSaveApproved: this.modeState.planSaveApproved,
    });
  }

  /**
   * Resolve the effective context window size from the configured provider.
   */
  private resolveContextWindowTokens(): number {
    return this.provider.getCapabilities().contextWindowTokens;
  }

  /**
   * Schedule a best-effort background summary refresh. If one is already
   * running, mark dirty so it reruns after completion. Non-fatal: failures
   * are logged via diagnostics and the previous summary is preserved.
   */
  private scheduleSummaryRefresh(
    reason: "turn_cadence" | "context_pressure",
  ): void {
    if (this.summaryRefreshRunning) {
      this.summaryDirty = true;
      return;
    }

    this.runSummaryRefresh(reason).catch(() => {
      // Errors already emitted as diagnostics; nothing to propagate.
    });
  }

  private async runSummaryRefresh(
    reason: "turn_cadence" | "context_pressure" | "synchronous_shrink",
  ): Promise<void> {
    if (
      this.contextManager.compactionFailures >=
      this.runtimeConfig.compactionFailureLimit
    ) {
      this.emitDiagnostic({
        type: "compaction_circuit_breaker_tripped",
        provider: this.provider.name,
        model: this.model,
        consecutiveFailures: this.contextManager.compactionFailures,
        limit: this.runtimeConfig.compactionFailureLimit,
      });
      return;
    }

    this.summaryRefreshRunning = true;
    this.summaryDirty = false;
    const generation = this.summaryGeneration;

    try {
      const eligibility = this.contextManager.getSummaryEligibility(
        this.summaryPolicy,
      );
      if (eligibility.eligibleTurns.length === 0) {
        return;
      }

      const startTime = Date.now();
      const result = await this.summaryManager.generateSummary(
        this.provider,
        this.model,
        eligibility.eligibleTurns,
        this.contextManager.getRollingSummary(),
        this.summaryPolicy,
        undefined,
        {
          onRequestMeasured: (metrics) => {
            this.emitDiagnostic({
              type: "summary_refresh_started",
              provider: this.provider.name,
              model: this.model,
              eligibleTurnCount: eligibility.eligibleTurns.length,
              newEligibleCount: eligibility.newEligibleCount,
              reason,
              promptMessageCount: metrics.promptMessageCount,
              promptChars: metrics.promptChars,
              estimatedPromptTokens: metrics.estimatedPromptTokens,
            });
          },
        },
      );

      if (this.summaryGeneration !== generation) {
        return;
      }

      this.contextManager.setRollingSummary(result.summary);
      this.contextManager.resetCompactionFailures();

      this.emitDiagnostic({
        type: "summary_refresh_completed",
        provider: this.provider.name,
        model: this.model,
        coveredTurnCount: result.summary.coveredTurnIds.length,
        summaryTokens: result.summary.estimatedTokens,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      this.emitDiagnostic({
        type: "summary_refresh_failed",
        provider: this.provider.name,
        model: this.model,
        errorName: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      });
      this.contextManager.incrementCompactionFailures();
    } finally {
      this.summaryRefreshRunning = false;

      if (this.summaryDirty && this.summaryGeneration === generation) {
        this.scheduleSummaryRefresh("turn_cadence");
      }
    }
  }

  /**
   * Attempt a synchronous summary refresh before escalating to the next
   * retry level. Returns true if the summary was refreshed (caller should
   * rebuild at the same level), false if nothing could be done (caller
   * should bump retryLevel).
   *
   * Only fires when the current plan omits unsummarized turns, meaning
   * a fresh summary would let the builder use the summary-aware path
   * instead of dropping them silently.
   */
  private async attemptSynchronousShrink(plan: PromptPlan): Promise<boolean> {
    const coveredIds = this.contextManager.getSummaryCoveredTurnIds();
    const uncoveredOmitted = plan.omittedTurnIds.filter(
      (id) => !coveredIds.has(id),
    );
    if (uncoveredOmitted.length === 0) {
      return false;
    }

    // Invalidate any in-flight background refresh so it cannot overwrite
    // the result we are about to produce. The background job checks
    // summaryGeneration before calling setRollingSummary and will discard
    // its stale result.
    if (this.summaryRefreshRunning) {
      this.summaryGeneration++;
      this.summaryDirty = false;
    }

    try {
      await this.runSummaryRefresh("synchronous_shrink");
    } catch {
      return false;
    }

    const newCoveredIds = this.contextManager.getSummaryCoveredTurnIds();
    return uncoveredOmitted.some((id) => newCoveredIds.has(id));
  }

  /**
   * Check eligibility and schedule a background refresh after a turn
   * completes. Called at the end of streamChat.
   */
  private checkAndScheduleSummary(): void {
    const contextWindow = this.resolveContextWindowTokens();
    const plan = this.buildPlan();
    const availableInputBudget = contextWindow - plan.reservedOutputTokens;

    const eligibility = this.contextManager.getSummaryEligibility(
      this.summaryPolicy,
      plan.estimatedPromptTokens,
      availableInputBudget,
    );

    if (eligibility.shouldRefresh && eligibility.reason) {
      this.scheduleSummaryRefresh(eligibility.reason);
    }
  }

  private buildPlan(
    extraUserInstruction?: string,
    retryLevel?: number,
    iteration?: number,
    allowedTools?: ReadonlySet<string>,
  ): PromptPlan {
    const contextWindowTokens = this.resolveContextWindowTokens();
    const policy: PromptBudgetPolicy = {
      ...DEFAULT_BUDGET_POLICY,
      maxRecentTurns: this.runtimeConfig.maxRecentTurns,
      artifactInlineCharCap: this.runtimeConfig.artifactInlineCharCap,
    };
    const { systemPrompt, runtimeContextOverflowBlock } =
      this.buildEffectiveSystemPrompt(allowedTools);

    const plan = this.contextManager.buildPromptPlan(
      systemPrompt,
      extraUserInstruction,
      {
        contextWindowTokens,
        retryLevel,
        policy,
        runtimeContextOverflowBlock,
      },
    );
    if (iteration != null) {
      this.lastPromptPlanSnapshot = {
        provider: this.provider.name,
        model: this.model,
        iteration,
        contextWindowTokens,
        availableInputBudget: contextWindowTokens - plan.reservedOutputTokens,
        plan,
      };
    }
    return plan;
  }

  /**
   * Adapt conversation history for the active provider. Providers that
   * reject synthetic assistant tool-call history (e.g. Gemini) get @mention
   * attachment pairs inlined into user messages instead.
   */
  private prepareMessagesForProvider(messages: ChatMessage[]): ChatMessage[] {
    if (
      this.provider.getCapabilities().supportsSyntheticToolCallHistory === false
    ) {
      return inlineSyntheticMentionPairs(messages);
    }
    return messages;
  }

  private maybePersistedResult(result: ArtifactToolResult): ArtifactToolResult {
    if (typeof result.rawContent !== "string" || !this.sessionsDir) {
      return result;
    }

    const bytes = Buffer.byteLength(result.rawContent, "utf8");
    const overSize = bytes > this.runtimeConfig.toolOutputPersistThreshold;
    const overAggregate =
      this.pendingToolResultBytes + bytes >
      this.runtimeConfig.aggregateToolResultsLimit;

    if (!overSize && !overAggregate) {
      this.pendingToolResultBytes += bytes;
      return result;
    }

    const persisted = persistToolOutput({
      toolName: result.toolName,
      content: result.rawContent,
      sessionsDir: this.sessionsDir,
      sessionId: this.sessionId,
      inlinePreviewBytes: this.runtimeConfig.toolOutputInlineLimit,
    });

    this.emitDiagnostic({
      type: "tool_output_persisted",
      toolName: result.toolName,
      sizeBytes: persisted.externalSizeBytes,
      reason: overSize ? "size_threshold" : "aggregate_cap",
    });

    this.pendingToolResultBytes += persisted.externalSizeBytes;

    return {
      ...result,
      rawContent: persisted.preview,
      externalStorage: {
        externalPath: persisted.externalPath,
        externalSizeBytes: persisted.externalSizeBytes,
        externalLineCount: persisted.externalLineCount,
      },
    };
  }

  private normalizeExtraInstruction(
    options?: AgentStreamOptions,
  ): string | undefined {
    const instruction = options?.extraUserInstruction;
    if (!instruction || !instruction.trim()) {
      return undefined;
    }
    return instruction;
  }

  private composeTurnExtraInstruction(
    options?: AgentStreamOptions,
  ): string | undefined {
    let composed = this.normalizeExtraInstruction(options);

    if (this.pendingExecuteSwitchReminder) {
      composed = composeExtraUserInstruction(
        composed,
        this.buildExecuteSwitchReminder(),
      );
      this.pendingExecuteSwitchReminder = false;
    }

    const mode = this.modeState.mode;
    if (mode === "plan" || mode === "discover") {
      const userTurnNumber =
        this.contextManager.getConversationState().turns.length;
      composed = composeExtraUserInstruction(
        composed,
        getModeReminder(
          {
            mode,
            planFilePath: this.modeState.planFilePath,
            planSaveApproved: this.modeState.planSaveApproved ?? false,
          },
          userTurnNumber,
        ),
      );
    }

    return composed;
  }

  private activeTurn = false;

  async streamChat(
    submission: PromptSubmission,
    onToken: (token: string) => void,
    options?: AgentStreamOptions,
  ): Promise<string> {
    if (this.activeTurn) throw new Error("An agent turn is already running");
    this.activeTurn = true;
    this.lastTurnReasoningSummary = null;
    this.sessionsDir = null;
    this.turnScratchpadDir = undefined;
    const { onToolStart, onToolEnd, ...runtimeOptions } = options ?? {};
    const runtime = this.createRuntime(onToolStart);
    try {
      return await runtime.streamChat(submission, onToken, {
        ...runtimeOptions,
        onEvent: (event) => {
          if (event.type === "reasoning_summary")
            this.lastTurnReasoningSummary = {
              summary: event.summary,
              source: event.source,
            };
          const formatted = this.formatRuntimeEvent(event);
          if (formatted) options?.onEvent?.(formatted);
          if (event.type === "tool_finished" || event.type === "tool_failed")
            onToolEnd?.(event.toolName, event.result, event.status);
        },
      });
    } catch (error) {
      throw this.handleProviderError(error);
    } finally {
      this.activeTurn = false;
    }
  }

  private createRuntime(onToolStart?: (name: string) => void): AgentRuntime {
    return new AgentRuntime({
      provider: this.provider,
      model: this.model,
      context: this.contextManager,
      systemPrompt: this.baseRules,
      policy: {
        maxIterations: this.runtimeConfig.maxIterations,
        useNoProgressDetector: this.runtimeConfig.useNoProgressDetector,
        streamIdleTimeoutMs: this.runtimeConfig.streamIdleTimeoutMs,
        outputTokenRecoveryLimit: this.runtimeConfig.outputTokenRecoveryLimit,
        discardInterruptedTurn: (signal) => signal.reason === "escape",
        allowedTools: () =>
          this.resolveAllowedTools(this.getActiveSkillScopes()),
      },
      tools: {
        getEnabledSchemas: () => this.getMergedToolSchemas(),
        executeWithStatus: (name, args, context) =>
          this.executeToolWithStatus(name, args, undefined, context?.signal),
      },
      onDiagnosticEvent: (event) => {
        this.emitDiagnostic(event);
        if (event.type === "tool_execution_started")
          onToolStart?.(event.toolName);
      },
      integrations: {
        prepareTurn: (submission) => this.attachFileMentions(submission.text),
        startTurn: () => this.startLocalTurn(),
        completeTurn: () => {
          this.checkAndScheduleSummary();
          this.finishLocalTurn();
        },
        failTurn: () => {
          this.contextManager.abandonSyntheticMentionOnlyTurn();
          this.finishLocalTurn();
        },
        instructions: (extraUserInstruction) =>
          this.composeTurnExtraInstruction({ extraUserInstruction }),
        prepareMessages: (messages) =>
          this.prepareMessagesForProvider(messages),
        buildPlan: (instruction, retry, iteration, allowed) =>
          this.buildPlan(instruction, retry, iteration, allowed),
        shrinkContext: (plan) => this.attemptSynchronousShrink(plan),
        onAssistantResponse: (content) =>
          this.recordPlanModeAssistantDraft(content),
        onToolSuccess: (name, args) =>
          this.recordSkillTouchFromToolArgs(name, args),
        onToolBatch: () => {
          this.pendingToolResultBytes = 0;
        },
        processToolResult: (result) => this.maybePersistedResult(result),
      },
    });
  }

  private startLocalTurn(): void {
    const sessionsDir = this.configuredSessionsDir ?? getDefaultSessionsDir();
    this.sessionsDir = sessionsDir;
    const resolved = resolveScratchpadDir(sessionsDir, this.sessionId);
    this.turnScratchpadDir = resolved.ok ? resolved.path : undefined;
    if (!resolved.ok) {
      this.emitDiagnostic({
        type: "scratchpad_unavailable",
        path: resolved.path,
        errorName: resolved.errorName,
        message: resolved.message,
      });
    }
    const marker: InProgressMarker = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      providerName: this.provider.name,
      modelKey: this.model,
      turnIndex: 0,
    };
    writeInProgressMarker(sessionsDir, this.sessionId, marker);
  }

  private finishLocalTurn(): void {
    if (this.sessionsDir) {
      try {
        clearInProgressMarker(this.sessionsDir, this.sessionId);
      } catch {
        /* Best-effort crash marker cleanup. */
      }
    }
    removeEmptyScratchpadDir(this.turnScratchpadDir);
  }

  private formatRuntimeEvent(
    event: RuntimeEvent,
  ): AgentVisibilityEvent | undefined {
    if (isRuntimeOnlyEvent(event)) return undefined;
    if (event.type === "tool_started") {
      return {
        ...event,
        activityLabel: this.describeToolInvocation(event.toolName, event.args),
        useLabel: this.toolRegistry.hasTool(event.toolName)
          ? this.toolRegistry.renderInvocationUse(event.toolName, event.args)
          : null,
      };
    }
    if (event.type === "tool_finished" || event.type === "tool_failed") {
      return {
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        activityLabel: this.describeToolInvocation(event.toolName, event.args),
        resultPreview:
          event.type === "tool_finished" &&
          this.toolRegistry.hasTool(event.toolName)
            ? this.toolRegistry.renderInvocationResult(
                event.toolName,
                event.args,
                event.result,
              )
            : event.resultPreview,
      };
    }
    return event;
  }

  clearContext(): void {
    this.summaryGeneration++;
    this.summaryDirty = false;
    this.lastPromptPlanSnapshot = null;
    this.contextManager.clear();
  }

  getContext(): ChatMessage[] {
    return this.contextManager.getSnapshot();
  }

  getConversationState(): ConversationState {
    return this.contextManager.getConversationState();
  }

  getActiveModelSelection(): ProviderModelSelection {
    return {
      providerName: this.resolvedProviderConfig.name,
      modelKey: this.model,
    };
  }

  getLastPromptPlan(): PromptPlanSnapshot | null {
    if (!this.lastPromptPlanSnapshot) return null;
    return structuredClone(this.lastPromptPlanSnapshot);
  }

  /**
   * Export the current session as a versioned JSON snapshot string.
   * The snapshot includes structured context state and runtime metadata
   * (provider, model, system prompt, policies) for analysis and future
   * resume UX. The metadata is informational; importing a snapshot does
   * not auto-switch provider/model.
   */
  getAgentMode(): AgentMode {
    return this.modeState.mode;
  }

  // fallow-ignore-next-line unused-class-member
  getAgentModeState(): AgentModeState {
    return { ...this.modeState };
  }

  getPlanFilePath(): string | undefined {
    return this.modeState.planFilePath;
  }

  isPlanSaveApproved(): boolean {
    return this.modeState.planSaveApproved ?? false;
  }

  getLatestAssistantPlanDraft(): string | undefined {
    if (this.latestPlanModeAssistantDraft) {
      return this.latestPlanModeAssistantDraft;
    }
    return this.findLatestAssistantDraftFromPlanBoundary();
  }

  private consumePendingPlanDraft(): void {
    this.latestPlanModeAssistantDraft = undefined;
    this.planDraftSearchStartTurnIndex =
      this.contextManager.getConversationState().turns.length;
  }

  private buildExecuteSwitchReminder(): string {
    const approvedPlan = getApprovedPlanPersistenceFields(this.modeState);
    if (!approvedPlan) {
      return getExecuteSwitchReminder();
    }

    try {
      const planContent = fs.readFileSync(approvedPlan.planFilePath, "utf8");
      const truncated =
        planContent.length > EXECUTE_SWITCH_REMINDER_PLAN_CONTENT_MAX_CHARS;
      return getExecuteSwitchReminder({
        planFilePath: approvedPlan.planFilePath,
        planContent: truncated
          ? planContent.slice(0, EXECUTE_SWITCH_REMINDER_PLAN_CONTENT_MAX_CHARS)
          : planContent,
        planContentTruncated: truncated,
      });
    } catch (error) {
      return getExecuteSwitchReminder({
        planFilePath: approvedPlan.planFilePath,
        unreadablePlanFileReason:
          error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resetPlanModeDraftTracking(): void {
    this.latestPlanModeAssistantDraft = undefined;
    this.planDraftSearchStartTurnIndex = undefined;
  }

  private beginPlanModeDraftTracking(): void {
    this.planDraftSearchStartTurnIndex =
      this.contextManager.getConversationState().turns.length;
    this.latestPlanModeAssistantDraft = undefined;
  }

  private restorePlanModeDraftTrackingFromImport(
    boundaryTurnIndex: number | undefined,
  ): void {
    if (this.modeState.mode !== "plan") {
      this.resetPlanModeDraftTracking();
      return;
    }

    this.planDraftSearchStartTurnIndex = boundaryTurnIndex ?? 0;
    this.latestPlanModeAssistantDraft = undefined;
    this.rebuildPlanModeAssistantDraftFromHistory();
  }

  private rebuildPlanModeAssistantDraftFromHistory(): void {
    const draft = this.findLatestAssistantDraftFromPlanBoundary();
    if (draft) {
      this.latestPlanModeAssistantDraft = draft;
    }
  }

  private findLatestAssistantDraftFromPlanBoundary(): string | undefined {
    if (this.planDraftSearchStartTurnIndex === undefined) {
      return undefined;
    }

    const state = this.contextManager.getConversationState();
    for (
      let turnIndex = state.turns.length - 1;
      turnIndex >= this.planDraftSearchStartTurnIndex;
      turnIndex--
    ) {
      const turn = state.turns[turnIndex]!;
      for (
        let entryIndex = turn.entries.length - 1;
        entryIndex >= 0;
        entryIndex--
      ) {
        const entry = turn.entries[entryIndex]!;
        if (entry.kind !== "assistant") continue;
        const content = entry.message.content?.trim();
        const proposedPlan = content
          ? extractProposedPlanContent(content)
          : undefined;
        if (proposedPlan) {
          return proposedPlan;
        }
      }
    }

    return undefined;
  }

  private recordPlanModeAssistantDraft(content: string): void {
    if (this.modeState.mode !== "plan") {
      return;
    }
    const proposedPlan = extractProposedPlanContent(content);
    if (proposedPlan) {
      this.latestPlanModeAssistantDraft = proposedPlan;
    }
  }

  saveApprovedPlan(
    content: string,
    options?: {
      slugHint?: string;
      onEvent?: (event: AgentVisibilityEvent) => void;
    },
  ): string {
    if (this.modeState.mode !== "plan") {
      throw new Error("Plan save is only available in Plan mode.");
    }

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("Plan content cannot be empty.");
    }

    const approvedPlan = getApprovedPlanPersistenceFields(this.modeState);
    const planFilePath = approvedPlan?.planFilePath
      ? approvedPlan.planFilePath
      : allocatePlanFile({
          sessionId: this.sessionId,
          cwd: this.skillContext.cwd,
          homeDir: this.skillContext.homeDir,
          slugHint: options?.slugHint,
        });
    writePlanFile(planFilePath, trimmed);

    this.modeState = {
      ...this.modeState,
      planFilePath,
      planSaveApproved: true,
    };
    this.consumePendingPlanDraft();

    const event: AgentVisibilityEvent = {
      type: "plan_saved",
      planFilePath,
    };
    this.emitVisibilityEvent({ onEvent: options?.onEvent }, event);

    return planFilePath;
  }

  private updatePlanDraftTrackingForModeChange(
    previousMode: AgentMode,
    mode: AgentMode,
  ): void {
    if (mode === "plan" && previousMode !== "plan") {
      this.beginPlanModeDraftTracking();
      return;
    }

    if (mode !== "plan" && previousMode === "plan") {
      this.resetPlanModeDraftTracking();
    }
  }

  private shouldRemindAfterExecuteSwitch(
    previousMode: AgentMode,
    mode: AgentMode,
  ): boolean {
    return (
      mode === "execute" &&
      (previousMode === "plan" || previousMode === "discover")
    );
  }

  setAgentMode(
    mode: AgentMode,
    options?: {
      slugHint?: string;
      onEvent?: (event: AgentVisibilityEvent) => void;
    },
  ): void {
    const previousMode = this.modeState.mode;
    if (previousMode === mode) {
      return;
    }

    const approvedPlan = getApprovedPlanPersistenceFields(this.modeState);

    this.modeState = {
      mode,
      ...(approvedPlan ?? {}),
      previousMode,
    };

    this.updatePlanDraftTrackingForModeChange(previousMode, mode);

    if (this.shouldRemindAfterExecuteSwitch(previousMode, mode)) {
      this.pendingExecuteSwitchReminder = true;
    }

    const event: AgentVisibilityEvent = {
      type: "mode_changed",
      mode,
      ...(approvedPlan ? { planFilePath: approvedPlan.planFilePath } : {}),
    };
    options?.onEvent?.(event);
    this.emitVisibilityEvent({ onEvent: options?.onEvent }, event);
  }

  cycleAgentMode(options?: {
    onEvent?: (event: AgentVisibilityEvent) => void;
  }): AgentMode {
    const currentIndex = AGENT_MODE_CYCLE.indexOf(this.modeState.mode);
    const nextMode =
      AGENT_MODE_CYCLE[(currentIndex + 1) % AGENT_MODE_CYCLE.length]!;
    this.setAgentMode(nextMode, options);
    return nextMode;
  }

  exportSession(): string {
    const state = this.contextManager.getConversationState();
    const approvedPlan = getApprovedPlanPersistenceFields(this.modeState);
    const metadata: SessionMetadata = {
      providerName: this.provider.name,
      modelKey: this.model,
      systemPrompt: this.baseRules,
      promptBudgetPolicy: DEFAULT_BUDGET_POLICY,
      summaryPolicy: this.summaryPolicy,
      contextWindowTokens: this.resolveContextWindowTokens(),
      sessionId: this.sessionId,
      agentMode: this.modeState.mode,
      ...(approvedPlan ?? {}),
      ...(this.modeState.mode === "plan" &&
      this.planDraftSearchStartTurnIndex !== undefined
        ? {
            planDraftSearchStartTurnIndex: this.planDraftSearchStartTurnIndex,
          }
        : {}),
    };
    return serializeSession(state, metadata);
  }

  /**
   * Import a validated snapshot into the current agent instance,
   * replacing all in-memory context state. Persisted metadata
   * (provider, model, system prompt) is preserved in the snapshot
   * for analysis but does not alter the agent's current configuration.
   *
   * If the snapshot contains a sessionId in metadata, adopt it for the
   * remainder of this agent instance (artifact directory continuity).
   *
   * Throws SessionParseError on malformed or unsupported snapshots.
   */
  importSession(json: string): void {
    const persisted = parseSession(json);
    const state = restoreConversationState(persisted);
    this.summaryGeneration++;
    this.summaryDirty = false;
    this.lastPromptPlanSnapshot = null;

    if (persisted.metadata.sessionId) {
      if (isSafeSessionId(persisted.metadata.sessionId)) {
        (this as any).sessionId = persisted.metadata.sessionId;
      } else {
        this.emitDiagnostic({
          type: "invalid_session_id",
          sessionId: persisted.metadata.sessionId,
          provider: this.provider.name,
          model: this.model,
        });
      }
    } else {
      this.emitDiagnostic({
        type: "legacy_session_no_id",
        provider: this.provider.name,
        model: this.model,
      });
    }

    this.contextManager.importState(state);

    const importedMode = persisted.metadata.agentMode ?? "execute";
    this.modeState = {
      mode: importedMode,
      ...resolveImportedPlanState(persisted.metadata),
    };
    this.pendingExecuteSwitchReminder = false;
    this.restorePlanModeDraftTrackingFromImport(
      persisted.metadata.planDraftSearchStartTurnIndex,
    );
  }

  // -------------------------------------------------------------------
  // Pinned memory (Phase 7)
  // -------------------------------------------------------------------

  pinFact(input: PinFactInput): string {
    return this.contextManager.pinFact(input);
  }

  addProjectConstraint(
    content: string,
    source: PinFactInput["source"],
    rationale?: string,
  ): string {
    return this.contextManager.addProjectConstraint(content, source, rationale);
  }

  updateMemory(id: string, input: UpdateMemoryInput): string {
    return this.contextManager.updateMemory(id, input);
  }

  unpinFact(id: string, rationale?: string): void {
    this.contextManager.unpinFact(id, rationale);
  }

  getPinnedMemory(opts?: {
    includeInactive?: boolean;
  }): ReadonlyArray<PinnedMemoryRecord> {
    return this.contextManager.getPinnedMemory(opts);
  }

  getLastTurnReasoningSummary(): TurnReasoningSummary | null {
    return this.lastTurnReasoningSummary
      ? { ...this.lastTurnReasoningSummary }
      : null;
  }

  setSystemPrompt(prompt: string): void {
    this.baseRules = prompt;
    this.systemPromptRegistry.invalidateCoreIdentity();
  }

  setGlobalInstallApprovalCallback(
    callback?: (request: GlobalInstallApprovalRequest) => Promise<boolean>,
  ): void {
    if (callback) {
      this.bashGlobalInstallGate.requestGlobalInstallApproval = callback;
      return;
    }
    delete this.bashGlobalInstallGate.requestGlobalInstallApproval;
  }

  getTools(): ChatTool[] {
    return this.getMergedToolSchemas();
  }

  getToolSummaries(): ReadonlyArray<ToolSummary> {
    return this.toolRegistry.getToolSummaries();
  }

  addTool(tool: PresentedTool): void {
    this.toolRegistry.register(tool, true);
  }

  enableTool(name: string): void {
    this.toolRegistry.enable(name);
  }

  disableTool(name: string): void {
    this.toolRegistry.disable(name);
  }

  enableAllTools(): void {
    this.toolRegistry.enableAll();
  }

  disableAllTools(): void {
    this.toolRegistry.disableAll();
  }

  resetToolsToManifestDefaults(): void {
    this.toolRegistry.resetToManifestDefaults();
  }

  getToolNames(): string[] {
    return this.toolRegistry.getToolNames();
  }

  isToolEnabled(name: string): boolean {
    return this.toolRegistry.isToolEnabled(name);
  }

  // fallow-ignore-next-line unused-class-member
  getMcpServerSummaries(): ReadonlyArray<McpServerSummary> {
    return this.mcpManager.getServerSummaries();
  }

  // fallow-ignore-next-line unused-class-member
  getMcpServerDetail(name: string): McpServerDetail | null {
    return this.mcpManager.getServerDetail(name);
  }

  // fallow-ignore-next-line unused-class-member
  listMcpTools(serverName?: string): ReadonlyArray<McpToolSummary> {
    return this.mcpManager.listTools(serverName);
  }

  // fallow-ignore-next-line unused-class-member
  async reconnectMcpServer(name: string): Promise<McpServerSummary> {
    return await this.mcpManager.reconnectServer(name);
  }

  // fallow-ignore-next-line unused-class-member
  async setMcpServerEnabled(
    name: string,
    enabled: boolean,
  ): Promise<McpServerSummary> {
    return await this.mcpManager.setServerEnabled(name, enabled);
  }

  private handleProviderError(error: any): Error {
    const providerName = this.provider.name;

    if (error instanceof ProviderAuthenticationError) {
      return new Error(
        `Provider ${providerName} authentication failed: ${error.message}`,
      );
    }

    if (error instanceof ProviderModelNotFoundError) {
      return new Error(
        `Model ${error.modelName} not found in provider ${providerName}: ${error.message}`,
      );
    }

    if (error instanceof ProviderError) {
      return new Error(`Provider ${providerName} error: ${error.message}`);
    }

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return new Error(
      `Failed to get response from ${providerName}: ${errorMessage}`,
    );
  }
}
