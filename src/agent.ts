import {
  type LLMProvider,
  type ChatMessage,
  type ChatTool,
  type ProviderDiagnosticEvent,
  type ProviderTraceEvent,
  type ChatRequest,
  ProviderError,
  ProviderAuthenticationError,
  ProviderModelNotFoundError,
  type ProvidersConfig,
  type ProviderConfig,
  createProvider,
  type ProviderModelSelection,
  resolveProvider,
  resolveModelKey,
  withProviderTracing,
} from "@propio-ai/providers";
import * as fs from "fs";
import * as os from "os";
import { createHash, randomUUID } from "crypto";
import {
  getInstalledPackageVersion,
  getPackageVersion,
} from "./packageVersion.js";
import {
  createRuntimeConfigOrigins,
  loadRuntimeConfigWithOrigins,
  type RuntimeConfig,
  type RuntimeConfigOrigins,
  type RuntimeConfigSource,
} from "./config/runtimeConfig.js";
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
  type AgentToolPolicyDecision,
  type AgentToolScope,
} from "./agent-core/index.js";
import { buildSystemPromptContext } from "./prompt/systemPromptContext.js";
import { ContextManager } from "./context/contextManager.js";
import type { ConversationRecoveryChange } from "./context/conversationManager.js";
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
import {
  SummaryManager,
  type SummaryGenerationHooks,
  type SummaryRefreshResult,
} from "./context/summaryManager.js";
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
  clearRecoveryCheckpoint,
  InProgressMarker,
} from "./sessions/sessionHistory.js";
import {
  appendRecoveryJournal,
  writeRecoveryJournalBase,
  type RecoveryJournalPosition,
} from "./sessions/recoveryJournal.js";
import {
  removeEmptyScratchpadDir,
  resolveScratchpadDir,
} from "./scratchpad/scratchpad.js";
import { isSafeSessionId } from "./sessions/sessionId.js";
import type { AgentTraceRecorder, TraceIdentity } from "./trace/index.js";
import { createTraceRevisionId } from "./trace/revisions.js";
import { capturedProviderEventPayload } from "./trace/providerPayload.js";
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

export interface AgentTraceRun {
  readonly recorder: AgentTraceRecorder;
  captureWorkspace?(phase: "baseline" | "checkpoint" | "final"): void;
  close?(): void;
}

export type AgentTraceRunFactory = (identity: TraceIdentity) => AgentTraceRun;

export type AgentConfigurationValueSource =
  | RuntimeConfigSource
  | "workspace"
  | "package_metadata"
  | "provider"
  | "mcp"
  | "session";

export interface AgentConfigurationOrigins {
  readonly providersConfig: AgentConfigurationValueSource;
  readonly provider: AgentConfigurationValueSource;
  readonly model: AgentConfigurationValueSource;
  readonly mode: AgentConfigurationValueSource;
  readonly systemPrompt: AgentConfigurationValueSource;
  readonly agentsMd: AgentConfigurationValueSource;
  readonly tools: AgentConfigurationValueSource;
  readonly mcp: AgentConfigurationValueSource;
  readonly workspace: AgentConfigurationValueSource;
  readonly planApproval: AgentConfigurationValueSource;
  readonly globalInstallApproval: AgentConfigurationValueSource;
}

type ConfigurationChangeScope =
  | "provider_model"
  | "mode"
  | "system_prompt"
  | "tool_scope"
  | "mcp"
  | "approval"
  | "session";

interface PendingConfigurationChange {
  readonly revisionId: string;
  readonly previousRevisionId: string;
  readonly changedAt: string;
  readonly cause: string;
  readonly scope: ConfigurationChangeScope;
  readonly configuration: Record<string, unknown>;
  readonly mode: AgentMode;
  readonly provider: string;
  readonly model: string;
  readonly enabledTools: ReadonlyArray<string>;
}

interface SummaryTraceContext {
  readonly traceRun: AgentTraceRun;
  readonly operationId: string;
  readonly reason: "turn_cadence" | "context_pressure" | "synchronous_shrink";
  readonly previousSummaryRevisionId?: string;
  promptRevisionId?: string;
}

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

interface PlanPolicySnapshot {
  readonly approved: boolean;
  readonly filePath?: string;
}

function resolveScopeMode(
  scope: AgentToolScope,
  fallback: AgentMode,
): AgentMode {
  const mode = scope.metadata?.mode;
  return mode === "execute" || mode === "plan" || mode === "discover"
    ? mode
    : fallback;
}

function resolvePlanPolicySnapshot(
  scope: AgentToolScope,
  fallback: AgentModeState,
): PlanPolicySnapshot {
  return {
    approved:
      typeof scope.metadata?.planSaveApproved === "boolean"
        ? scope.metadata.planSaveApproved
        : (fallback.planSaveApproved ?? false),
    filePath:
      typeof scope.metadata?.planFilePath === "string"
        ? scope.metadata.planFilePath
        : fallback.planFilePath,
  };
}

function authorizePlanTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
  mode: AgentMode,
  plan: PlanPolicySnapshot,
): AgentToolPolicyDecision | undefined {
  if (mode !== "plan" || !["write", "edit"].includes(name)) return undefined;
  if (!plan.approved || !plan.filePath) {
    return {
      allowed: false,
      actor: "agent",
      rule: "plan_write_approval",
      reason:
        "In Plan mode, file writes require an approved plan save (/plan save) before write/edit is enabled.",
      metadata: { mode },
    };
  }
  if (!isPlanFilePath(args.path, plan.filePath)) {
    return {
      allowed: false,
      actor: "agent",
      rule: "plan_write_path",
      reason: `In Plan mode, write/edit is only allowed for the approved plan file (${plan.filePath})`,
      metadata: { mode },
    };
  }
  return undefined;
}

function authorizeBashTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
  mode: AgentMode,
): AgentToolPolicyDecision | undefined {
  if (name !== "bash" || !["plan", "discover"].includes(mode)) {
    return undefined;
  }
  const command =
    typeof args.command === "string"
      ? args.command
      : String(args.command ?? "");
  const bashPolicy = checkBashAllowedForMode(command, mode);
  if (bashPolicy.allowed) return undefined;
  return {
    allowed: false,
    actor: "agent",
    rule: "mode_bash_policy",
    reason: bashPolicy.reason ?? "Command not allowed in this mode",
    metadata: { mode },
  };
}

type MutableAgentConfigurationOrigins = {
  -readonly [
    K in keyof AgentConfigurationOrigins
  ]: AgentConfigurationOrigins[K];
};

function resolveInitialConfigurationOrigins(
  options: {
    providersConfig: ProvidersConfig | string;
    providerName?: string;
    modelKey?: string;
    mcpConfig?: McpConfigFile;
    mcpConfigPath?: string;
    systemPrompt?: string;
    agentsMdContent?: string;
    cwd?: string;
  },
  overrides: Partial<AgentConfigurationOrigins> = {},
): MutableAgentConfigurationOrigins {
  const providersConfigSource =
    typeof options.providersConfig === "string" ? "settings" : "application";
  const origins: MutableAgentConfigurationOrigins = {
    providersConfig: providersConfigSource,
    provider: options.providerName ? "application" : providersConfigSource,
    model: options.modelKey ? "application" : providersConfigSource,
    mode: "default",
    systemPrompt:
      options.systemPrompt === undefined ? "default" : "application",
    agentsMd: options.agentsMdContent === undefined ? "default" : "application",
    tools: "default",
    mcp: options.mcpConfig || options.mcpConfigPath ? "application" : "default",
    workspace: options.cwd === undefined ? "workspace" : "application",
    planApproval: "default",
    globalInstallApproval: "default",
  };
  return applyConfigurationOriginOverrides(origins, overrides);
}

function applyConfigurationOriginOverrides(
  origins: MutableAgentConfigurationOrigins,
  overrides: Partial<AgentConfigurationOrigins>,
): MutableAgentConfigurationOrigins {
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      origins[key as keyof AgentConfigurationOrigins] = value;
    }
  }
  return origins;
}

function redactUrlCredentials(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "[REDACTED]";
    if (parsed.password) parsed.password = "[REDACTED]";
    for (const key of parsed.searchParams.keys()) {
      if (/key|password|secret|token/i.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return parsed.toString();
  } catch {
    return createTraceRevisionId(value);
  }
}

function buildRedactedProviderConfig(
  provider: ProviderConfig,
): Record<string, unknown> {
  const common = {
    name: provider.name,
    type: provider.type,
    defaultModel: provider.defaultModel,
    models: provider.models.map((model) => ({ ...model })),
  };
  switch (provider.type) {
    case "ollama":
      return { ...common, host: redactUrlCredentials(provider.host) };
    case "bedrock":
      return { ...common, region: provider.region };
    case "openrouter":
      return {
        ...common,
        httpReferer: redactUrlCredentials(provider.httpReferer),
        xTitle: provider.xTitle,
        provider: provider.provider,
        fallbackModels: provider.fallbackModels,
        debugEchoUpstreamBody: provider.debugEchoUpstreamBody,
      };
    case "cloudflare":
      return { ...common, accountId: provider.accountId };
    default:
      return common;
  }
}

function modeConfigurationChanged(
  previous: AgentModeState,
  next: AgentModeState,
): boolean {
  return (
    previous.mode !== next.mode ||
    previous.planSaveApproved !== next.planSaveApproved ||
    previous.planFilePath !== next.planFilePath
  );
}

function capturePackageVersion(readVersion: () => string): string {
  try {
    return readVersion();
  } catch {
    return "unavailable";
  }
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
  private readonly toolConfigurationOrigins = new Map<
    string,
    AgentConfigurationValueSource
  >();
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
  private readonly runtimeConfigOrigins: RuntimeConfigOrigins;
  private readonly configurationOrigins: MutableAgentConfigurationOrigins;
  private readonly bashGlobalInstallGate: BashGlobalInstallGateConfig;
  private sessionsDir: string | null = null;
  private readonly configuredSessionsDir?: string;
  private turnScratchpadDir: string | undefined;
  private pendingToolResultBytes = 0;
  private modeState: AgentModeState = { mode: "execute" };
  private pendingExecuteSwitchReminder = false;
  private latestPlanModeAssistantDraft?: string;
  private planDraftSearchStartTurnIndex?: number;
  private readonly createTraceRun?: AgentTraceRunFactory;
  private activeTraceRun?: AgentTraceRun;
  private configurationRevisionId = randomUUID();
  private readonly pendingConfigurationChanges: PendingConfigurationChange[] =
    [];
  private lastTraceRunId?: string;
  private pendingRecoveredToolCallIds: string[] = [];
  private recoveryCheckpointRequested = false;
  private recoveryJournalPosition?: RecoveryJournalPosition;
  private pendingRecoveryChanges: ConversationRecoveryChange[] = [];
  private recoverySkillCount = 0;
  private readonly onRecoveryCheckpointFailure?: (error: Error) => void;

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
      runtimeConfigOrigins?: Partial<RuntimeConfigOrigins>;
      configurationOrigins?: Partial<AgentConfigurationOrigins>;
      /** Application-owned trace storage. Omit to keep the Agent free of trace I/O. */
      createTraceRun?: AgentTraceRunFactory;
      onRecoveryCheckpointFailure?: (error: Error) => void;
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
    this.createTraceRun = options.createTraceRun;
    this.onRecoveryCheckpointFailure = options.onRecoveryCheckpointFailure;

    this.sessionId = randomUUID();
    const resolvedRuntimeConfig = options.runtimeConfig
      ? {
          config: options.runtimeConfig,
          origins: createRuntimeConfigOrigins(
            "application",
            options.runtimeConfigOrigins,
          ),
        }
      : loadRuntimeConfigWithOrigins();
    this.runtimeConfig = resolvedRuntimeConfig.config;
    this.runtimeConfigOrigins = resolvedRuntimeConfig.origins;
    this.configurationOrigins = resolveInitialConfigurationOrigins(
      options,
      options.configurationOrigins,
    );
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
    this.provider = withProviderTracing(
      createProvider(
        resolvedProvider,
        resolvedModelKey,
        this.diagnosticsEnabled ? this.forwardProviderDiagnostic : undefined,
        this.diagnosticsEnabled,
        {
          maxRetries: this.runtimeConfig.maxRetries,
          consecutive529Limit: this.runtimeConfig.consecutive529FallbackLimit,
        },
      ),
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
    this.activeTraceRun?.close?.();
    this.activeTraceRun = undefined;
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

  private async executeToolWithStatus(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (this.toolRegistry.hasTool(name)) {
      return await this.toolRegistry.executeWithStatus(name, args, { signal });
    }

    if (this.mcpManager.hasTool(name)) {
      return await this.mcpManager.executeToolWithStatus(name, args);
    }

    return { status: "tool_not_found", content: `Tool not found: ${name}` };
  }

  private authorizeToolExecution(
    name: string,
    args: Readonly<Record<string, unknown>>,
    scope: AgentToolScope,
  ): AgentToolPolicyDecision {
    const mode = resolveScopeMode(scope, this.modeState.mode);
    const planDecision = authorizePlanTool(
      name,
      args,
      mode,
      resolvePlanPolicySnapshot(scope, this.modeState),
    );
    if (planDecision) return planDecision;
    const bashDecision = authorizeBashTool(name, args, mode);
    if (bashDecision) return bashDecision;

    return {
      allowed: true,
      actor: "agent",
      rule: "mode_policy",
      reason: `Tool is allowed in ${mode} mode`,
      metadata: { mode },
    };
  }

  switchProvider(providerName: string, modelKey?: string): void {
    const resolvedProvider = resolveProvider(
      this.providersConfig,
      providerName,
    );
    const resolvedModelKey = resolveModelKey(resolvedProvider, modelKey);
    const newProvider = withProviderTracing(
      createProvider(
        resolvedProvider,
        resolvedModelKey,
        this.diagnosticsEnabled ? this.forwardProviderDiagnostic : undefined,
        this.diagnosticsEnabled,
        {
          maxRetries: this.runtimeConfig.maxRetries,
          consecutive529Limit: this.runtimeConfig.consecutive529FallbackLimit,
        },
      ),
    );

    this.resolvedProviderConfig = resolvedProvider;
    this.provider = newProvider;
    this.model = resolvedModelKey;
    this.configurationOrigins.provider = "runtime_change";
    this.configurationOrigins.model = "runtime_change";
    this.recordConfigurationChange(
      "provider_or_model_changed",
      "provider_model",
    );
  }

  private recordConfigurationChange(
    cause: string,
    scope: ConfigurationChangeScope,
  ): void {
    const previousRevisionId = this.configurationRevisionId;
    this.configurationRevisionId = randomUUID();
    if (!this.createTraceRun) return;
    const change: PendingConfigurationChange = {
      revisionId: this.configurationRevisionId,
      previousRevisionId,
      changedAt: new Date().toISOString(),
      cause,
      scope,
      configuration: this.captureRedactedConfigurationSnapshot(),
      mode: this.modeState.mode,
      provider: this.provider.name,
      model: this.model,
      enabledTools: this.captureEnabledToolNames(),
    };
    if (!this.activeTraceRun) {
      this.pendingConfigurationChanges.push(change);
      return;
    }
    this.recordConfigurationChangeEvent(change);
  }

  private recordConfigurationChangeEvent(
    change: PendingConfigurationChange,
  ): void {
    try {
      this.activeTraceRun?.recorder.record({
        component: "configuration",
        type: "configuration_revision_changed",
        identity: { configurationRevisionId: change.revisionId },
        payload: {
          previousRevisionId: change.previousRevisionId,
          changedAt: change.changedAt,
          cause: change.cause,
          scope: change.scope,
          configuration: change.configuration,
          mode: change.mode,
          provider: change.provider,
          model: change.model,
          enabledTools: change.enabledTools,
        },
      });
    } catch {
      // Trace capture is observational and must not affect configuration changes.
    }
  }

  private flushPendingConfigurationChanges(): void {
    while (this.activeTraceRun && this.pendingConfigurationChanges.length > 0) {
      const change = this.pendingConfigurationChanges[0];
      this.recordConfigurationChangeEvent(change);
      this.pendingConfigurationChanges.shift();
    }
  }

  private createRuntimeTraceRecorder(): AgentTraceRecorder | undefined {
    const recorder = this.activeTraceRun?.recorder;
    if (!recorder) return undefined;
    const agent = this;
    return {
      get identity() {
        return {
          ...recorder.identity,
          configurationRevisionId: agent.configurationRevisionId,
        };
      },
      get captureLevel() {
        return recorder.captureLevel;
      },
      captureMaterial(value) {
        return recorder.captureMaterial?.(value);
      },
      record(event, options) {
        recorder.record(
          {
            ...event,
            identity: {
              configurationRevisionId: agent.configurationRevisionId,
              ...event.identity,
            },
          },
          options,
        );
      },
    };
  }

  private tryStartTraceRun(runId: string): AgentTraceRun | undefined {
    let traceRun: AgentTraceRun | undefined;
    try {
      traceRun = this.createTraceRun?.({
        sessionId: this.sessionId,
        runId,
        configurationRevisionId: this.configurationRevisionId,
        previousRunId: this.lastTraceRunId,
      });
      this.activeTraceRun = traceRun;
      traceRun?.recorder.record(
        {
          component: "cli",
          type: "run_started",
          payload: {
            provider: this.provider.name,
            model: this.model,
            previousRunId: this.lastTraceRunId,
            configuration: this.buildRedactedConfigurationSnapshot(),
          },
        },
        { durable: true },
      );
      traceRun?.captureWorkspace?.("baseline");
      this.flushPendingConfigurationChanges();
      for (const toolCallId of this.pendingRecoveredToolCallIds) {
        traceRun?.recorder.record(
          {
            component: "tool",
            type: "recovered_tool_call_unresolved",
            identity: { toolCallId },
            payload: {
              previousRunId: this.lastTraceRunId,
              outcome: "unknown",
              replayed: false,
            },
          },
          { durable: true },
        );
      }
      if (traceRun) this.pendingRecoveredToolCallIds = [];
      return traceRun;
    } catch {
      if (this.activeTraceRun === traceRun) this.activeTraceRun = undefined;
      this.closeTraceRun(traceRun);
      return undefined;
    }
  }

  private closeTraceRun(traceRun: AgentTraceRun | undefined): void {
    try {
      traceRun?.close?.();
    } catch {
      // Trace capture is observational and must not affect the agent turn.
    }
  }

  private reportRecoveryCheckpointFailure(
    error: unknown,
    sessionId = this.sessionId,
  ): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    try {
      this.emitDiagnostic({
        type: "recovery_checkpoint_failed",
        sessionId,
        runId: this.activeTraceRun?.recorder.identity.runId,
        errorName: failure.name,
        message: failure.message,
      });
    } catch {
      // Diagnostic sinks must not change tool or session behavior.
    }
    try {
      this.onRecoveryCheckpointFailure?.(failure);
    } catch {
      // The independent warning channel is also observational.
    }
  }

  private tryStartSummaryTrace(
    reason: SummaryTraceContext["reason"],
    eligibleTurnCount: number,
    newEligibleCount: number,
    previousSummaryRevisionId?: string,
  ): SummaryTraceContext | undefined {
    if (!this.createTraceRun) return undefined;
    const parentRunId =
      this.activeTraceRun?.recorder.identity.runId ?? this.lastTraceRunId;
    let traceRun: AgentTraceRun | undefined;
    try {
      traceRun = this.createTraceRun({
        sessionId: this.sessionId,
        runId: randomUUID(),
        configurationRevisionId: this.configurationRevisionId,
        previousRunId: parentRunId,
      });
      const context: SummaryTraceContext = {
        traceRun,
        operationId: randomUUID(),
        reason,
        previousSummaryRevisionId,
      };
      traceRun.recorder.record(
        {
          component: "cli",
          type: "run_started",
          identity: { operationId: context.operationId },
          payload: {
            kind: "summary_refresh",
            reason,
            parentRunId,
            configuration: this.buildRedactedConfigurationSnapshot(),
          },
        },
        { durable: true },
      );
      traceRun.captureWorkspace?.("baseline");
      traceRun.recorder.record({
        component: "context",
        type: "summary_refresh_started",
        identity: {
          operationId: context.operationId,
          summaryRevisionId: previousSummaryRevisionId,
        },
        payload: {
          reason,
          eligibleTurnCount,
          newEligibleCount,
          previousSummaryRevisionId,
        },
      });
      return context;
    } catch {
      this.closeTraceRun(traceRun);
      return undefined;
    }
  }

  private recordSummaryTrace(
    context: SummaryTraceContext | undefined,
    event: Parameters<AgentTraceRecorder["record"]>[0],
    options?: Parameters<AgentTraceRecorder["record"]>[1],
  ): void {
    try {
      context?.traceRun.recorder.record(event, options);
    } catch {
      // Trace capture is observational and must not affect summarization.
    }
  }

  private prepareSummaryTraceRequest(
    context: SummaryTraceContext,
    request: ChatRequest,
  ): ChatRequest {
    const recorder = context.traceRun.recorder;
    const requestId = randomUUID();
    const operationId = randomUUID();
    context.promptRevisionId = createTraceRevisionId({
      model: request.model,
      messages: request.messages,
    });
    const identity = {
      requestId,
      operationId,
      parentOperationId: context.operationId,
      promptRevisionId: context.promptRevisionId,
      summaryRevisionId: context.previousSummaryRevisionId,
    };
    const requestMaterial =
      recorder.captureLevel === "full"
        ? recorder.captureMaterial?.({
            model: request.model,
            messages: request.messages,
            tools: [],
          })
        : undefined;
    this.recordSummaryTrace(context, {
      component: "agent",
      type: "provider_request_dispatched",
      identity,
      payload: {
        purpose: "summarize",
        provider: this.provider.name,
        model: request.model,
        messageCount: request.messages.length,
        toolCount: 0,
        captureLevel: recorder.captureLevel ?? "standard",
        requestMaterial,
        outboundPayloadFingerprint: createTraceRevisionId({
          model: request.model,
          messages: request.messages,
        }),
      },
    });
    const previousObserver = request.onTraceEvent;
    return {
      ...request,
      ...{ captureRequestPayload: recorder.captureLevel === "full" },
      trace: {
        sessionId: recorder.identity.sessionId,
        runId: recorder.identity.runId,
        requestId,
        operationId,
        parentOperationId: context.operationId,
        purpose: "summarize",
        configurationRevisionId: recorder.identity.configurationRevisionId,
        promptRevisionId: context.promptRevisionId,
      },
      onTraceEvent: (event) => {
        previousObserver?.(event);
        this.recordSummaryProviderTraceEvent(context, event);
      },
    };
  }

  private recordSummaryProviderTraceEvent(
    context: SummaryTraceContext,
    event: ProviderTraceEvent,
  ): void {
    const payload = capturedProviderEventPayload(
      event,
      context.traceRun.recorder,
    );
    this.recordSummaryTrace(
      context,
      {
        component: "provider",
        type: event.type,
        identity: {
          requestId: event.trace.requestId,
          operationId: event.trace.operationId,
          parentOperationId: event.trace.parentOperationId,
          configurationRevisionId: event.trace.configurationRevisionId,
          promptRevisionId: event.trace.promptRevisionId,
          summaryRevisionId: context.previousSummaryRevisionId,
          attemptId: "attemptId" in event ? event.attemptId : undefined,
        },
        payload,
      },
      {
        durable:
          event.type === "provider_request_completed" ||
          event.type === "provider_request_failed",
      },
    );
  }

  private closeSummaryTrace(context: SummaryTraceContext | undefined): void {
    if (!context) return;
    try {
      context.traceRun.captureWorkspace?.("final");
    } catch {
      // Summary capture is observational.
    }
    this.recordSummaryTrace(
      context,
      {
        component: "cli",
        type: "run_closed",
        identity: { operationId: context.operationId },
        payload: { kind: "summary_refresh" },
      },
      { durable: true },
    );
    this.closeTraceRun(context.traceRun);
  }

  private resolveProviderCredentialMetadata(): {
    readonly present: boolean;
    readonly source: string;
  } {
    const provider = this.resolvedProviderConfig as ProviderConfig & {
      apiKey?: string;
    };
    if (Boolean(provider.apiKey)) {
      return {
        present: true,
        source: this.configurationOrigins.providersConfig,
      };
    }

    const environmentVariables: Partial<
      Record<ProviderConfig["type"], ReadonlyArray<string>>
    > = {
      anthropic: ["ANTHROPIC_API_KEY"],
      bedrock: [
        "AWS_ACCESS_KEY_ID",
        "AWS_PROFILE",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      ],
      cloudflare: [
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_AUTH_TOKEN",
        "CLOUDFLARE_API_KEY",
      ],
      gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      meta: ["META_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      xai: ["XAI_API_KEY"],
    };
    const present = (environmentVariables[provider.type] ?? []).some((name) =>
      Boolean(process.env[name]),
    );
    if (present) return { present: true, source: "environment" };
    if (provider.type === "bedrock") {
      return { present: false, source: "provider_chain_or_absent" };
    }
    return { present: false, source: "absent" };
  }

  private captureEnabledToolNames(): ReadonlyArray<string> {
    try {
      return this.getTools().map((tool) => tool.function.name);
    } catch {
      return [];
    }
  }

  private captureRedactedConfigurationSnapshot(): Record<string, unknown> {
    try {
      return this.buildRedactedConfigurationSnapshot();
    } catch {
      return {
        revisionId: this.configurationRevisionId,
        capture: { status: "unavailable", reason: "snapshot_failed" },
      };
    }
  }

  private buildRedactedConfigurationSnapshot(): Record<string, unknown> {
    const provider = this.resolvedProviderConfig;
    const tools = this.getMergedToolSchemas()
      .map((tool) => ({
        name: tool.function.name,
        schemaRevisionId: createTraceRevisionId(tool),
        source: this.toolRegistry.hasTool(tool.function.name)
          ? (this.toolConfigurationOrigins.get(tool.function.name) ?? "default")
          : "mcp",
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const mcpServerSummaries =
      typeof this.mcpManager.getServerSummaries === "function"
        ? this.mcpManager.getServerSummaries()
        : [];
    const mcpServers = mcpServerSummaries
      .map((server) => ({
        name: server.name,
        enabled: server.enabled,
        status: server.status,
        toolCount: server.toolCount,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const configuration = {
      packages: {
        agent: capturePackageVersion(() => getPackageVersion()),
        providers: capturePackageVersion(() =>
          getInstalledPackageVersion("@propio-ai/providers"),
        ),
      },
      provider: {
        name: provider.name,
        type: provider.type,
        implementationName: this.provider.name,
        model: this.model,
        capabilities: this.provider.getCapabilities(),
        credential: this.resolveProviderCredentialMetadata(),
        config: buildRedactedProviderConfig(provider),
      },
      runtime: { ...this.runtimeConfig },
      runtimeSources: { ...this.runtimeConfigOrigins },
      mode: this.modeState.mode,
      approvals: {
        planSaveApproved: this.modeState.planSaveApproved ?? false,
        planFileRevisionId: this.modeState.planFilePath
          ? createTraceRevisionId(this.modeState.planFilePath)
          : undefined,
        globalInstallApprovalCallbackConfigured: Boolean(
          this.bashGlobalInstallGate.requestGlobalInstallApproval,
        ),
        allowGlobalInstallsWithoutPrompt:
          this.runtimeConfig.allowGlobalInstallsWithoutPrompt,
      },
      prompt: {
        coreIdentityRevisionId: createTraceRevisionId(this.baseRules),
        agentsMdRevisionId: this.agentsMdContent
          ? createTraceRevisionId(this.agentsMdContent)
          : undefined,
      },
      tools,
      mcpServers,
      workspace: {
        revisionId: createTraceRevisionId({ cwd: this.skillContext.cwd }),
      },
      sources: {
        packages: "package_metadata",
        providersConfig: this.configurationOrigins.providersConfig,
        provider: this.configurationOrigins.provider,
        providerCapabilities: "provider",
        model: this.configurationOrigins.model,
        mode: this.configurationOrigins.mode,
        planApproval: this.configurationOrigins.planApproval,
        globalInstallApproval: this.configurationOrigins.globalInstallApproval,
        systemPrompt: this.configurationOrigins.systemPrompt,
        agentsMd: this.configurationOrigins.agentsMd,
        tools: this.configurationOrigins.tools,
        mcp: this.configurationOrigins.mcp,
        workspace: this.configurationOrigins.workspace,
      },
    };
    return {
      revisionId: this.configurationRevisionId,
      fingerprint: createTraceRevisionId(configuration),
      ...configuration,
    };
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

  private resolveRuntimeToolScope() {
    const invokedSkills =
      this.contextManager.getConversationState().invokedSkills ?? [];
    const skillScopes = invokedSkills.map((record) => record.scope);
    const allowedTools = this.resolveAllowedTools(skillScopes);
    const activeSkills = invokedSkills
      .map((record) => ({
        name: record.name,
        source: record.source,
        revisionId: `sha256:${createHash("sha256").update(record.content).digest("hex")}`,
      }))
      .sort((a, b) =>
        a.name === b.name
          ? a.revisionId.localeCompare(b.revisionId)
          : a.name.localeCompare(b.name),
      );
    const allowedToolNames = allowedTools
      ? [...allowedTools].sort()
      : undefined;
    const metadata = {
      mode: this.modeState.mode,
      activeSkills,
      planSaveApproved: this.modeState.planSaveApproved ?? false,
      planFilePath: this.modeState.planFilePath,
    };
    const fingerprint = JSON.stringify({ ...metadata, allowedToolNames });
    return {
      allowedTools,
      policyRevisionId: this.configurationRevisionId,
      toolScopeRevisionId: `sha256:${createHash("sha256").update(fingerprint).digest("hex")}`,
      metadata,
    };
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

  private resolveSummaryRevisionId(
    summary: ReturnType<ContextManager["getRollingSummary"]>,
  ): string | undefined {
    if (!summary) return undefined;
    return (
      summary.revisionId ??
      createTraceRevisionId({
        content: summary.content,
        coveredTurnIds: summary.coveredTurnIds,
      })
    );
  }

  private buildSummaryGenerationHooks(
    reason: SummaryTraceContext["reason"],
    eligibleTurnCount: number,
    newEligibleCount: number,
    summaryTrace: SummaryTraceContext | undefined,
  ): SummaryGenerationHooks {
    const hooks: SummaryGenerationHooks = {
      onRequestMeasured: (metrics) => {
        this.emitDiagnostic({
          type: "summary_refresh_started",
          provider: this.provider.name,
          model: this.model,
          eligibleTurnCount,
          newEligibleCount,
          reason,
          promptMessageCount: metrics.promptMessageCount,
          promptChars: metrics.promptChars,
          estimatedPromptTokens: metrics.estimatedPromptTokens,
        });
      },
    };
    if (!summaryTrace) return hooks;
    return {
      ...hooks,
      prepareRequest: (request) =>
        this.prepareSummaryTraceRequest(summaryTrace, request),
      onResponse: (request, content) => {
        const recorder = summaryTrace.traceRun.recorder;
        if (recorder.captureLevel !== "full") return;
        const responseMaterial = recorder.captureMaterial?.({
          content,
          completed: true,
        });
        this.recordSummaryTrace(summaryTrace, {
          component: "agent",
          type: "provider_response_captured",
          identity: {
            requestId: request.trace?.requestId,
            operationId: request.trace?.operationId,
            promptRevisionId: request.trace?.promptRevisionId,
          },
          payload: { purpose: "summarize", completed: true, responseMaterial },
        });
      },
    };
  }

  private recordDiscardedSummaryTrace(
    summaryTrace: SummaryTraceContext | undefined,
  ): void {
    this.recordSummaryTrace(
      summaryTrace,
      {
        component: "context",
        type: "summary_refresh_discarded",
        identity: {
          operationId: summaryTrace?.operationId,
          promptRevisionId: summaryTrace?.promptRevisionId,
        },
        payload: { reason: "superseded_generation" },
      },
      { durable: true },
    );
  }

  private recordCreatedSummaryTrace(
    summaryTrace: SummaryTraceContext | undefined,
    reason: SummaryTraceContext["reason"],
    previousSummaryRevisionId: string | undefined,
    result: SummaryRefreshResult,
  ): void {
    this.recordSummaryTrace(
      summaryTrace,
      {
        component: "context",
        type: "summary_revision_created",
        identity: {
          operationId: summaryTrace?.operationId,
          promptRevisionId: summaryTrace?.promptRevisionId,
          summaryRevisionId: this.resolveSummaryRevisionId(result.summary),
        },
        payload: {
          reason,
          previousSummaryRevisionId,
          coveredTurnIds: result.summary.coveredTurnIds,
          refreshedTurnCount: result.refreshedTurnCount,
          estimatedTokens: result.summary.estimatedTokens,
        },
      },
      { durable: true },
    );
  }

  private recordFailedSummaryTrace(
    summaryTrace: SummaryTraceContext | undefined,
    reason: SummaryTraceContext["reason"],
    error: unknown,
  ): void {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : String(error);
    this.recordSummaryTrace(
      summaryTrace,
      {
        component: "context",
        type: "summary_refresh_failed",
        identity: {
          operationId: summaryTrace?.operationId,
          promptRevisionId: summaryTrace?.promptRevisionId,
          summaryRevisionId: summaryTrace?.previousSummaryRevisionId,
        },
        payload: { reason, errorName, message },
      },
      { durable: true },
    );
    this.emitDiagnostic({
      type: "summary_refresh_failed",
      provider: this.provider.name,
      model: this.model,
      errorName,
      message,
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
    let summaryTrace: SummaryTraceContext | undefined;

    try {
      const eligibility = this.contextManager.getSummaryEligibility(
        this.summaryPolicy,
      );
      if (eligibility.eligibleTurns.length === 0) {
        return;
      }

      const previousSummary = this.contextManager.getRollingSummary();
      const previousSummaryRevisionId =
        this.resolveSummaryRevisionId(previousSummary);
      summaryTrace = this.tryStartSummaryTrace(
        reason,
        eligibility.eligibleTurns.length,
        eligibility.newEligibleCount,
        previousSummaryRevisionId,
      );

      const startTime = Date.now();
      const result = await this.summaryManager.generateSummary(
        this.provider,
        this.model,
        eligibility.eligibleTurns,
        previousSummary,
        this.summaryPolicy,
        undefined,
        this.buildSummaryGenerationHooks(
          reason,
          eligibility.eligibleTurns.length,
          eligibility.newEligibleCount,
          summaryTrace,
        ),
      );

      if (this.summaryGeneration !== generation) {
        this.recordDiscardedSummaryTrace(summaryTrace);
        return;
      }

      this.contextManager.setRollingSummary(result.summary);
      this.contextManager.resetCompactionFailures();
      this.recordCreatedSummaryTrace(
        summaryTrace,
        reason,
        previousSummaryRevisionId,
        result,
      );

      this.emitDiagnostic({
        type: "summary_refresh_completed",
        provider: this.provider.name,
        model: this.model,
        coveredTurnCount: result.summary.coveredTurnIds.length,
        summaryTokens: result.summary.estimatedTokens,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      this.recordFailedSummaryTrace(summaryTrace, reason, error);
      this.contextManager.incrementCompactionFailures();
    } finally {
      this.closeSummaryTrace(summaryTrace);
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

  private describePromptPlan(plan: PromptPlan) {
    const summary = this.contextManager.getRollingSummary();
    const coveredTurnIds = new Set(summary?.coveredTurnIds ?? []);
    const invokedSkills =
      this.contextManager.getConversationState().invokedSkills ?? [];
    return {
      summaryRevisionId:
        plan.usedRollingSummary && summary
          ? (summary.revisionId ??
            createTraceRevisionId({
              content: summary.content,
              coveredTurnIds: summary.coveredTurnIds,
            }))
          : undefined,
      instructionRevisions: [
        {
          source: "base_system_prompt",
          scope: "session",
          revisionId: createTraceRevisionId(this.baseRules),
        },
        ...(this.agentsMdContent
          ? [
              {
                source: "agents_md",
                scope: "workspace",
                revisionId: createTraceRevisionId(this.agentsMdContent),
              },
            ]
          : []),
        ...invokedSkills.map((skill) => ({
          source: `skill:${skill.name}`,
          scope: skill.source,
          revisionId: createTraceRevisionId(skill.content),
        })),
      ],
      omissions: plan.omittedTurnIds.map((id) => ({
        kind: "turn" as const,
        id,
        reason:
          plan.usedRollingSummary && coveredTurnIds.has(id)
            ? "covered_by_rolling_summary"
            : plan.retryLevel > 0
              ? "context_retry_budget"
              : "prompt_budget",
      })),
    };
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

  // fallow-ignore-next-line complexity
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
    const runId = randomUUID();
    let traceRun: AgentTraceRun | undefined;
    try {
      traceRun = this.tryStartTraceRun(runId);
      const runtime = this.createRuntime(onToolStart);
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
      if (this.recoveryCheckpointRequested) {
        this.writeSessionRecoveryCheckpoint();
      }
      try {
        traceRun?.captureWorkspace?.("final");
      } catch {
        // Workspace capture must not replace the turn result.
      }
      try {
        traceRun?.recorder.record(
          { component: "cli", type: "run_closed", payload: {} },
          { durable: true },
        );
      } catch {
        // Trace capture is observational and must not wedge the agent.
      }
      this.closeTraceRun(traceRun);
      if (this.activeTraceRun === traceRun) this.activeTraceRun = undefined;
      if (traceRun) this.lastTraceRunId = runId;
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
        resolveToolScope: () => this.resolveRuntimeToolScope(),
      },
      tools: {
        getEnabledSchemas: () => this.getMergedToolSchemas(),
        executeWithStatus: (name, args, context) =>
          this.executeToolWithStatus(name, args, context?.signal),
      },
      onDiagnosticEvent: (event) => {
        this.emitDiagnostic(event);
        if (event.type === "tool_execution_started")
          onToolStart?.(event.toolName);
      },
      trace: this.createRuntimeTraceRecorder(),
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
        describePromptPlan: (plan) => this.describePromptPlan(plan),
        authorizeTool: ({ name, args, scope }) =>
          this.authorizeToolExecution(name, args, scope),
        shrinkContext: (plan) => this.attemptSynchronousShrink(plan),
        onAssistantResponse: (content) =>
          this.recordPlanModeAssistantDraft(content),
        onToolSuccess: (name, args) =>
          this.recordSkillTouchFromToolArgs(name, args),
        onToolBatch: () => {
          this.pendingToolResultBytes = 0;
        },
        processToolResult: (result) => this.maybePersistedResult(result),
        onToolResultCommitted: () => {
          if (!this.createTraceRun && !this.recoveryCheckpointRequested) return;
          this.recoveryCheckpointRequested = true;
          this.writeSessionRecoveryCheckpoint();
          try {
            this.activeTraceRun?.captureWorkspace?.("checkpoint");
          } catch {
            // A completed result remains independent of workspace capture.
          }
        },
      },
    });
  }

  private writeSessionRecoveryCheckpoint(): void {
    const traceRun = this.activeTraceRun;
    if (!this.sessionsDir) {
      this.reportRecoveryCheckpointFailure(
        new Error("Session directory unavailable for recovery checkpoint"),
      );
      return;
    }
    try {
      if (this.recoveryJournalPosition) {
        this.recoveryJournalPosition = appendRecoveryJournal(
          this.sessionsDir,
          this.sessionId,
          this.recoveryJournalPosition,
          this.sessionMetadata(),
          this.pendingRecoveryChanges,
          this.contextManager.getInvokedSkillsSince(this.recoverySkillCount),
        );
      } else {
        this.recoveryJournalPosition = writeRecoveryJournalBase(
          this.sessionsDir,
          this.exportSession(),
        );
        this.contextManager.setRecoveryChangeListener((change) => {
          this.pendingRecoveryChanges.push(change);
        });
      }
      this.pendingRecoveryChanges = [];
      this.recoverySkillCount = this.contextManager.getInvokedSkillCount();
    } catch (error) {
      this.contextManager.setRecoveryChangeListener(undefined);
      this.recoveryJournalPosition = undefined;
      this.pendingRecoveryChanges = [];
      const failure = error instanceof Error ? error : new Error(String(error));
      try {
        traceRun?.recorder.record(
          {
            component: "context",
            type: "recovery_checkpoint_failed",
            payload: { errorName: failure.name, message: failure.message },
          },
          { durable: true },
        );
      } catch {
        // The warning callback is independent of the trace sink.
      }
      this.reportRecoveryCheckpointFailure(failure);
      return;
    }
    try {
      traceRun?.recorder.record({
        component: "context",
        type: "recovery_checkpoint_written",
        payload: { sessionId: this.sessionId },
      });
    } catch {
      // The checkpoint is durable independently of trace capture.
    }
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
    this.contextManager.setRecoveryChangeListener(undefined);
    this.recoveryJournalPosition = undefined;
    this.pendingRecoveryChanges = [];
    this.recoverySkillCount = 0;
    this.summaryGeneration++;
    this.summaryDirty = false;
    this.lastPromptPlanSnapshot = null;
    this.contextManager.clear();
    this.pendingRecoveredToolCallIds = [];
    if (this.recoveryCheckpointRequested) {
      try {
        clearRecoveryCheckpoint(
          this.configuredSessionsDir ?? getDefaultSessionsDir(),
          this.sessionId,
        );
        this.recoveryCheckpointRequested = false;
      } catch (error) {
        this.reportRecoveryCheckpointFailure(error);
      }
    }
  }

  getContext(): ChatMessage[] {
    return this.contextManager.getSnapshot();
  }

  getConversationState(): ConversationState {
    return this.contextManager.getConversationState();
  }

  // Called through SessionAgent by the session command handler.
  // fallow-ignore-next-line unused-class-member
  getRuntimeSessionId(): string {
    return this.sessionId;
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
    this.configurationOrigins.planApproval = "runtime_change";
    this.recordConfigurationChange("plan_save_approved", "approval");
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
      source?: AgentConfigurationValueSource;
    },
  ): void {
    const previousMode = this.modeState.mode;
    if (previousMode === mode) {
      this.recordModeSourceChange(options?.source);
      return;
    }

    const approvedPlan = getApprovedPlanPersistenceFields(this.modeState);

    this.modeState = {
      mode,
      ...(approvedPlan ?? {}),
      previousMode,
    };
    this.configurationOrigins.mode = options?.source ?? "runtime_change";
    this.recordConfigurationChange("mode_changed", "mode");

    this.updatePlanDraftTrackingForModeChange(previousMode, mode);

    if (this.shouldRemindAfterExecuteSwitch(previousMode, mode)) {
      this.pendingExecuteSwitchReminder = true;
    }

    this.emitModeChangedEvent(mode, approvedPlan, options?.onEvent);
  }

  private emitModeChangedEvent(
    mode: AgentMode,
    approvedPlan: ReturnType<typeof getApprovedPlanPersistenceFields>,
    onEvent: ((event: AgentVisibilityEvent) => void) | undefined,
  ): void {
    const event: AgentVisibilityEvent = {
      type: "mode_changed",
      mode,
      ...(approvedPlan ? { planFilePath: approvedPlan.planFilePath } : {}),
    };
    onEvent?.(event);
    this.emitVisibilityEvent({ onEvent }, event);
  }

  private recordModeSourceChange(
    source: AgentConfigurationValueSource | undefined,
  ): void {
    if (!source || source === this.configurationOrigins.mode) return;
    this.configurationOrigins.mode = source;
    this.recordConfigurationChange("mode_source_changed", "mode");
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
    return serializeSession(state, this.sessionMetadata());
  }

  private sessionMetadata(): SessionMetadata {
    const approvedPlan = getApprovedPlanPersistenceFields(this.modeState);
    return {
      providerName: this.provider.name,
      modelKey: this.model,
      systemPrompt: this.baseRules,
      promptBudgetPolicy: DEFAULT_BUDGET_POLICY,
      summaryPolicy: this.summaryPolicy,
      contextWindowTokens: this.resolveContextWindowTokens(),
      sessionId: this.sessionId,
      lastTraceRunId:
        this.activeTraceRun?.recorder.identity.runId ?? this.lastTraceRunId,
      agentMode: this.modeState.mode,
      ...(approvedPlan ?? {}),
      ...(this.modeState.mode === "plan" &&
      this.planDraftSearchStartTurnIndex !== undefined
        ? {
            planDraftSearchStartTurnIndex: this.planDraftSearchStartTurnIndex,
          }
        : {}),
    };
  }

  /** Fill only missing responses in a recovery checkpoint; never execute them. */
  private reconcileRecoveredToolCalls(): string[] {
    const unresolved = this.findMissingRecoveryToolCalls();
    if (unresolved.length === 0) return [];

    this.contextManager.recordToolResults(
      unresolved.map((call) => ({
        toolCallId: call.id,
        toolName: call.name,
        status: "error" as const,
        rawContent:
          "[Recovery: no durable tool result in the session checkpoint. Completion is unknown; the tool was not replayed.]",
      })),
    );
    return unresolved.map((call) => call.id);
  }

  private findMissingRecoveryToolCalls(): Array<{ id: string; name: string }> {
    const turns = this.contextManager.getConversationState().turns;
    const turn = turns[turns.length - 1];
    if (!turn || turn.completedAt) return [];

    let assistantIndex = -1;
    for (let index = turn.entries.length - 1; index >= 0; index--) {
      if (turn.entries[index]?.kind === "assistant") {
        assistantIndex = index;
        break;
      }
    }
    if (assistantIndex < 0) return [];
    const calls = turn.entries[assistantIndex]?.message.toolCalls ?? [];
    if (calls.length === 0) return [];

    const recorded = new Set(
      turn.entries
        .slice(assistantIndex + 1)
        .flatMap((entry) =>
          entry.kind === "tool" ? (entry.toolInvocations ?? []) : [],
        )
        .map((invocation) => invocation.toolCallId),
    );
    return calls.flatMap((call) =>
      typeof call.id === "string" && !recorded.has(call.id)
        ? [{ id: call.id, name: call.function.name }]
        : [],
    );
  }

  private retireOutgoingRecoveryCheckpoint(
    sessionId: string,
    wasRequested: boolean,
    incomingIsRecovery: boolean,
  ): void {
    if (!wasRequested || (sessionId === this.sessionId && incomingIsRecovery)) {
      return;
    }
    try {
      clearRecoveryCheckpoint(
        this.configuredSessionsDir ?? getDefaultSessionsDir(),
        sessionId,
      );
    } catch (error) {
      this.reportRecoveryCheckpointFailure(error, sessionId);
    }
  }

  private adoptImportedSessionId(sessionId: string | undefined): void {
    if (sessionId && isSafeSessionId(sessionId)) {
      (this as any).sessionId = sessionId;
      return;
    }
    this.emitDiagnostic(
      sessionId
        ? {
            type: "invalid_session_id",
            sessionId,
            provider: this.provider.name,
            model: this.model,
          }
        : {
            type: "legacy_session_no_id",
            provider: this.provider.name,
            model: this.model,
          },
    );
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
    const outgoingSessionId = this.sessionId;
    const outgoingRecoveryRequested = this.recoveryCheckpointRequested;
    this.contextManager.setRecoveryChangeListener(undefined);
    this.recoveryJournalPosition = undefined;
    this.pendingRecoveryChanges = [];
    this.recoverySkillCount = 0;
    this.summaryGeneration++;
    this.summaryDirty = false;
    this.lastPromptPlanSnapshot = null;

    this.adoptImportedSessionId(persisted.metadata.sessionId);

    this.lastTraceRunId = persisted.metadata.lastTraceRunId;

    this.contextManager.importState(state);
    this.recoveryCheckpointRequested =
      persisted.metadata.recoveryCheckpoint === true;
    const unresolved = persisted.metadata.recoveryCheckpoint
      ? this.reconcileRecoveredToolCalls()
      : [];
    this.pendingRecoveredToolCallIds = this.createTraceRun ? unresolved : [];

    const previousModeState = this.modeState;
    const importedMode = persisted.metadata.agentMode ?? "execute";
    const importedModeState: AgentModeState = {
      mode: importedMode,
      ...resolveImportedPlanState(persisted.metadata),
    };
    this.modeState = importedModeState;
    if (modeConfigurationChanged(previousModeState, importedModeState)) {
      if (previousModeState.mode !== importedModeState.mode) {
        this.configurationOrigins.mode = "session";
      }
      if (
        previousModeState.planSaveApproved !==
          importedModeState.planSaveApproved ||
        previousModeState.planFilePath !== importedModeState.planFilePath
      ) {
        this.configurationOrigins.planApproval = "session";
      }
      this.recordConfigurationChange(
        "session_configuration_imported",
        "session",
      );
    }
    this.pendingExecuteSwitchReminder = false;
    this.restorePlanModeDraftTrackingFromImport(
      persisted.metadata.planDraftSearchStartTurnIndex,
    );
    this.retireOutgoingRecoveryCheckpoint(
      outgoingSessionId,
      outgoingRecoveryRequested,
      persisted.metadata.recoveryCheckpoint === true,
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
    if (
      this.baseRules === prompt &&
      this.configurationOrigins.systemPrompt === "runtime_change"
    ) {
      return;
    }
    this.baseRules = prompt;
    this.systemPromptRegistry.invalidateCoreIdentity();
    this.configurationOrigins.systemPrompt = "runtime_change";
    this.recordConfigurationChange("system_prompt_changed", "system_prompt");
  }

  setGlobalInstallApprovalCallback(
    callback?: (request: GlobalInstallApprovalRequest) => Promise<boolean>,
    source: AgentConfigurationValueSource = "runtime_change",
  ): void {
    if (callback) {
      this.bashGlobalInstallGate.requestGlobalInstallApproval = callback;
    } else {
      delete this.bashGlobalInstallGate.requestGlobalInstallApproval;
    }
    this.configurationOrigins.globalInstallApproval = source;
    this.recordConfigurationChange(
      callback
        ? "global_install_approval_callback_configured"
        : "global_install_approval_callback_removed",
      "approval",
    );
  }

  getTools(): ChatTool[] {
    return this.getMergedToolSchemas();
  }

  getToolSummaries(): ReadonlyArray<ToolSummary> {
    return this.toolRegistry.getToolSummaries();
  }

  addTool(tool: PresentedTool): void {
    this.toolRegistry.register(tool, true);
    this.toolConfigurationOrigins.set(tool.name, "runtime_change");
    this.configurationOrigins.tools = "runtime_change";
    if (!this.activeTraceRun && !this.lastTraceRunId) return;
    this.recordConfigurationChange(
      `tool_registered:${tool.name}`,
      "tool_scope",
    );
  }

  enableTool(name: string): void {
    this.toolRegistry.enable(name);
    this.configurationOrigins.tools = "runtime_change";
    this.recordConfigurationChange(`tool_enabled:${name}`, "tool_scope");
  }

  disableTool(name: string): void {
    this.toolRegistry.disable(name);
    this.configurationOrigins.tools = "runtime_change";
    this.recordConfigurationChange(`tool_disabled:${name}`, "tool_scope");
  }

  enableAllTools(): void {
    this.toolRegistry.enableAll();
    this.configurationOrigins.tools = "runtime_change";
    this.recordConfigurationChange("all_tools_enabled", "tool_scope");
  }

  disableAllTools(): void {
    this.toolRegistry.disableAll();
    this.configurationOrigins.tools = "runtime_change";
    this.recordConfigurationChange("all_tools_disabled", "tool_scope");
  }

  resetToolsToManifestDefaults(): void {
    this.toolRegistry.resetToManifestDefaults();
    this.configurationOrigins.tools = "runtime_change";
    this.recordConfigurationChange("tool_defaults_restored", "tool_scope");
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
    const summary = await this.mcpManager.reconnectServer(name);
    this.configurationOrigins.mcp = "runtime_change";
    this.recordConfigurationChange(`mcp_server_reconnected:${name}`, "mcp");
    return summary;
  }

  // fallow-ignore-next-line unused-class-member
  async setMcpServerEnabled(
    name: string,
    enabled: boolean,
  ): Promise<McpServerSummary> {
    const summary = await this.mcpManager.setServerEnabled(name, enabled);
    this.configurationOrigins.mcp = "runtime_change";
    this.recordConfigurationChange(
      `mcp_server_${enabled ? "enabled" : "disabled"}:${name}`,
      "mcp",
    );
    return summary;
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
