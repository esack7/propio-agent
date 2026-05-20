import { LLMProvider } from "./providers/interface.js";
import * as os from "os";
import { randomUUID } from "crypto";
import { loadRuntimeConfig, RuntimeConfig } from "./config/runtimeConfig.js";
import {
  ChatMessage,
  ChatTool,
  ChatToolCall,
  ChatStreamEvent,
  ProviderReasoningSummarySource,
  ProviderError,
  ProviderAuthenticationError,
  ProviderModelNotFoundError,
  ProviderContextLengthError,
} from "./providers/types.js";
import { ProvidersConfig, ProviderConfig } from "./providers/config.js";
import { createProvider } from "./providers/factory.js";
import {
  loadProvidersConfig,
  type ProviderModelSelection,
  resolveProvider,
  resolveModelKey,
} from "./providers/configLoader.js";
import { ToolRegistry } from "./tools/registry.js";
import { createDefaultToolRegistry } from "./tools/factory.js";
import { ExecutableTool } from "./tools/interface.js";
import type { ToolSummary } from "./tools/registry.js";
import type {
  ToolExecutionResult,
  ToolExecutionStatus,
} from "./tools/types.js";
import { persistToolOutput } from "./tools/outputPersistence.js";
import { measureMessages, RESERVED_OUTPUT_TOKENS } from "./diagnostics.js";
import type { AgentDiagnosticEvent } from "./diagnostics.js";
import { composeSystemPrompt } from "./agentsMd.js";
import { ContextManager } from "./context/contextManager.js";
import {
  ArtifactToolResult,
  PromptBudgetPolicy,
  DEFAULT_BUDGET_POLICY,
  SummaryPolicy,
  DEFAULT_SUMMARY_POLICY,
  PromptPlan,
  ConversationState,
  TurnEntry,
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
} from "./skills/types.js";
import { SkillRegistry } from "./skills/registry.js";
import { createMissingSkillError } from "./skills/shared.js";
import { renderSkillDiscoveryBlock } from "./skills/discovery.js";
import { AttachmentResolver } from "./fileSearch/attachmentResolver.js";

export type AgentVisibilityEvent =
  | { type: "status"; status: string; phase?: string }
  | {
      type: "tool_started";
      toolName: string;
      toolCallId: string;
      activityLabel: string;
      useLabel: string | null;
      args: Record<string, unknown>;
      argumentChars: number;
      argumentPreview: string;
    }
  | {
      type: "tool_finished";
      toolName: string;
      toolCallId: string;
      activityLabel: string;
      resultPreview: string;
    }
  | {
      type: "tool_failed";
      toolName: string;
      toolCallId: string;
      activityLabel: string;
      resultPreview: string;
    }
  | {
      type: "reasoning_summary";
      summary: string;
      source: ProviderReasoningSummarySource;
    }
  | {
      type: "prompt_plan_built";
      snapshot: PromptPlanSnapshot;
    };

export interface TurnReasoningSummary {
  summary: string;
  source: ProviderReasoningSummarySource;
}

type AgentEventOptions = {
  readonly onEvent?: (event: AgentVisibilityEvent) => void;
};

type AgentToolOptions = AgentEventOptions & {
  /**
   * @deprecated Use onEvent with the tool_started event instead.
   */
  readonly onToolStart?: (toolName: string) => void;
  /**
   * @deprecated Use onEvent with tool_finished/tool_failed events instead.
   */
  readonly onToolEnd?: (
    toolName: string,
    result: string,
    status: ToolExecutionStatus,
  ) => void;
  readonly abortSignal?: AbortSignal;
};

type AgentStreamOptions = AgentToolOptions & {
  readonly extraUserInstruction?: string;
  readonly maxIterations?: number;
};

/**
 * Snapshot of a prompt plan plus the provider/model metadata that was
 * active when the plan was built. Surfaced via Agent.getLastPromptPlan()
 * for the /context prompt introspection command.
 */
export interface PromptPlanSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly iteration: number;
  readonly contextWindowTokens: number;
  readonly availableInputBudget: number;
  readonly plan: PromptPlan;
}

function stableArgsKey(
  args: Record<string, unknown> | null | undefined,
): string {
  if (!args || typeof args !== "object") return "";
  return Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join("|");
}

export class Agent {
  private static readonly MAX_EMPTY_TOOL_ONLY_STREAK = 3;
  private static readonly MAX_VISIBILITY_PREVIEW_CHARS = 120;
  private static readonly MAX_CONTEXT_RETRY_LEVEL = 3;
  private provider!: LLMProvider;
  private model!: string;
  private resolvedProviderConfig!: ProviderConfig;
  private contextManager: ContextManager;
  private systemPrompt: string;
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
  private sessionsDir: string | null = null;
  private pendingToolResultBytes = 0;

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

    const basePrompt =
      options.systemPrompt || "You are a helpful AI assistant.";

    this.systemPrompt = composeSystemPrompt(
      options.agentsMdContent ?? "",
      basePrompt,
    );

    this.providersConfig = Agent.normalizeProvidersConfig(
      options.providersConfig,
    );
    this.diagnosticsEnabled = options.diagnosticsEnabled ?? false;
    this.diagnosticsListener = options.onDiagnosticEvent;
    this.skillContext = {
      cwd: options.cwd ?? process.cwd(),
      homeDir: options.homeDir ?? os.homedir(),
    };

    this.sessionId = randomUUID();
    this.runtimeConfig = options.runtimeConfig ?? loadRuntimeConfig();
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
      this.diagnosticsEnabled ? this.diagnosticsListener : undefined,
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
    allowedTools?: ReadonlySet<string>,
  ): Promise<ToolExecutionResult> {
    if (allowedTools && !allowedTools.has(name)) {
      return {
        status: "tool_disabled",
        content: `Tool not available in the current skill scope: ${name}`,
      };
    }

    if (this.toolRegistry.hasTool(name)) {
      return await this.toolRegistry.executeWithStatus(name, args);
    }

    if (this.mcpManager.hasTool(name)) {
      return await this.mcpManager.executeToolWithStatus(name, args);
    }

    return { status: "tool_not_found", content: `Tool not found: ${name}` };
  }

  private emitStatus(
    options: AgentEventOptions | undefined,
    status: string,
    phase?: string,
  ): void {
    this.emitVisibilityEvent(options, { type: "status", status, phase });
  }

  private toPreview(text: string): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= Agent.MAX_VISIBILITY_PREVIEW_CHARS) {
      return compact;
    }
    return `${compact.slice(0, Agent.MAX_VISIBILITY_PREVIEW_CHARS)}...`;
  }

  private normalizeStreamEvent(event: ChatStreamEvent): {
    delta?: string;
    toolCalls?: ChatToolCall[];
    reasoningContent?: string;
    status?: { status: string; phase?: string };
    reasoningSummary?: {
      summary: string;
      source: ProviderReasoningSummarySource;
    };
    stopReason?: string;
  } {
    if (!("type" in event)) {
      return {
        delta: event.delta,
        toolCalls: event.toolCalls,
      };
    }

    if (event.type === "assistant_text") {
      return { delta: event.delta };
    }

    if (event.type === "tool_calls") {
      return {
        toolCalls: event.toolCalls,
        reasoningContent: event.reasoningContent,
      };
    }

    if (event.type === "status") {
      return { status: { status: event.status, phase: event.phase } };
    }

    if (event.type === "reasoning_summary") {
      return {
        reasoningSummary: {
          summary: event.summary,
          source: event.source,
        },
      };
    }

    if (event.type === "terminal") {
      return { stopReason: event.stopReason };
    }

    return {};
  }

  private detectNoProgress(
    _currentToolCalls?: ChatToolCall[],
    lookback: number = 5,
  ): boolean {
    const state = this.contextManager.getConversationState();
    const turns = state.turns;

    if (turns.length === 0) return false;

    const lastTurn = turns[turns.length - 1];
    const recentEntries = lastTurn.entries.slice(-lookback);
    // commitAssistantResponse already ran before this check, so the current
    // iteration's assistant entry is already in history; read from there only.
    const { signatures, hasAnyAssistantText } =
      this.gatherSignaturesFromTurnEntries(recentEntries);

    if (hasAnyAssistantText) return false;
    if (signatures.length < 3) return false;

    return new Set(signatures).size === 1;
  }

  private gatherSignaturesFromTurnEntries(entries: ReadonlyArray<TurnEntry>): {
    signatures: string[];
    hasAnyAssistantText: boolean;
  } {
    const signatures: string[] = [];
    let hasAnyAssistantText = false;
    for (const entry of entries) {
      if (entry.kind !== "assistant") continue;
      if (entry.message.content?.trim().length > 0) {
        hasAnyAssistantText = true;
      }
      for (const tc of entry.message.toolCalls ?? []) {
        signatures.push(
          `${tc.function.name}:${stableArgsKey(tc.function.arguments)}`,
        );
      }
    }
    return { signatures, hasAnyAssistantText };
  }

  private synthesizeAgentReasoningSummary(
    iterationCount: number,
    toolExecutionEvents: Array<{ name: string; failed: boolean }>,
  ): string {
    if (toolExecutionEvents.length === 0) {
      return iterationCount > 1
        ? "Reviewed prior context and generated the final answer without running tools."
        : "Read your request and generated the answer directly without running tools.";
    }

    const namesInOrder: string[] = [];
    for (const event of toolExecutionEvents) {
      if (!namesInOrder.includes(event.name)) {
        namesInOrder.push(event.name);
      }
    }
    const failedCount = toolExecutionEvents.filter(
      (event) => event.failed,
    ).length;
    const completedCount = toolExecutionEvents.length - failedCount;
    const toolLabel =
      namesInOrder.length === 1
        ? namesInOrder[0]
        : `${namesInOrder.slice(0, -1).join(", ")} and ${namesInOrder[namesInOrder.length - 1]}`;

    if (failedCount === 0) {
      return `Used ${toolLabel}, processed the results, then generated the final answer.`;
    }

    return `Used ${toolLabel}; ${completedCount} completed and ${failedCount} failed. Continued with the available results to produce the final answer.`;
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
      this.diagnosticsEnabled ? this.diagnosticsListener : undefined,
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
      this.recordSkillFileTouch(touchedPaths);
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

  private getEffectiveSystemPrompt(): string {
    const discoveryBlock = this.composeSkillDiscoveryBlock();
    if (!discoveryBlock) {
      return this.systemPrompt;
    }

    return `${this.systemPrompt}\n\n${discoveryBlock}`;
  }

  private deriveAllowedToolScope(
    scopes: ReadonlyArray<SkillInvocationScope>,
  ): ReadonlySet<string> | undefined {
    const scopedLists = scopes
      .map((scope) => scope.allowedTools)
      .filter(
        (allowedTools): allowedTools is readonly string[] =>
          Array.isArray(allowedTools) && allowedTools.length > 0,
      );

    if (scopedLists.length === 0) {
      return undefined;
    }

    let allowed = new Set(scopedLists[0]);
    for (const list of scopedLists.slice(1)) {
      allowed = new Set([...allowed].filter((tool) => list.includes(tool)));
    }

    return allowed;
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
  ): PromptPlan {
    const contextWindowTokens = this.resolveContextWindowTokens();
    const policy: PromptBudgetPolicy = {
      ...DEFAULT_BUDGET_POLICY,
      maxRecentTurns: this.runtimeConfig.maxRecentTurns,
      artifactInlineCharCap: this.runtimeConfig.artifactInlineCharCap,
    };
    const plan = this.contextManager.buildPromptPlan(
      this.getEffectiveSystemPrompt(),
      extraUserInstruction,
      {
        contextWindowTokens,
        retryLevel,
        policy,
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

  private emitPromptPlanDiagnostic(plan: PromptPlan, iteration: number): void {
    const contextWindowTokens = this.resolveContextWindowTokens();
    this.emitDiagnostic({
      type: "prompt_plan",
      provider: this.provider.name,
      model: this.model,
      iteration,
      contextWindowTokens,
      availableInputBudget: contextWindowTokens - plan.reservedOutputTokens,
      estimatedPromptTokens: plan.estimatedPromptTokens,
      reservedOutputTokens: plan.reservedOutputTokens,
      retryLevel: plan.retryLevel,
      includedTurnCount: plan.includedTurnIds.length,
      omittedTurnCount: plan.omittedTurnIds.length,
      includedArtifactCount: plan.includedArtifactIds.length,
      usedRollingSummary: plan.usedRollingSummary,
    });
  }

  private emitPromptPlanAndRequestStartedDiagnostics(
    plan: PromptPlan,
    messages: ChatMessage[],
    iteration: number,
    enabledTools: number,
    options: AgentEventOptions | undefined,
  ): void {
    this.emitPromptPlanDiagnostic(plan, iteration);
    this.emitVisibilityEvent(options, {
      type: "prompt_plan_built",
      snapshot: structuredClone(this.lastPromptPlanSnapshot!),
    });
    const contextSnapshot = this.contextManager.getSnapshot();
    const contextMetrics = measureMessages(contextSnapshot);
    this.emitDiagnostic({
      type: "context_snapshot",
      ...contextMetrics,
    });
    const promptMetrics = measureMessages(messages);
    this.emitDiagnostic({
      type: "request_started",
      provider: this.provider.name,
      model: this.model,
      iteration,
      contextMessages: messages.length,
      enabledTools,
      promptMessageCount: promptMetrics.messageCount,
      promptChars: promptMetrics.totalChars,
      estimatedPromptTokens: promptMetrics.estimatedTokens,
      reservedOutputTokens: plan.reservedOutputTokens,
    });
  }

  private recordStreamChunk(
    normalizedEvent: ReturnType<Agent["normalizeStreamEvent"]>,
    iteration: number,
    state: { fullResponse: string; chunkCount: number },
    onToken: (token: string) => void,
  ): void {
    const token = normalizedEvent.delta ?? "";
    if (token) {
      state.fullResponse += token;
    }
    state.chunkCount++;
    this.emitDiagnostic({
      type: "chunk_received",
      provider: this.provider.name,
      model: this.model,
      iteration,
      chunkIndex: state.chunkCount,
      chunkChars: token.length,
      accumulatedChars: state.fullResponse.length,
    });
    if (token) {
      onToken(token);
    }
  }

  private normalizeAndEmitStreamEvent(
    event: ChatStreamEvent,
    options: AgentEventOptions | undefined,
    abortSignal: AbortSignal | undefined,
  ): ReturnType<Agent["normalizeStreamEvent"]> {
    if (abortSignal?.aborted) {
      throw new Error("Request cancelled");
    }

    const normalizedEvent = this.normalizeStreamEvent(event);

    if (normalizedEvent.status) {
      this.emitStatus(
        options,
        normalizedEvent.status.status,
        normalizedEvent.status.phase,
      );
    }

    return normalizedEvent;
  }

  private async streamFinalResponseWithoutTools(
    messages: ChatMessage[],
    onToken: (token: string) => void,
    abortSignal: AbortSignal | undefined,
    iteration: number,
    options: AgentEventOptions | undefined,
  ): Promise<string> {
    const streamState = { fullResponse: "", chunkCount: 0 };
    this.emitStatus(options, "Streaming response", "response");
    for await (const event of this.withStreamIdleWatchdog(
      this.provider.streamChat({
        model: this.model,
        messages,
        signal: abortSignal,
        iteration,
      }),
      iteration,
    )) {
      const normalizedEvent = this.normalizeAndEmitStreamEvent(
        event,
        options,
        abortSignal,
      );
      this.recordStreamChunk(normalizedEvent, iteration, streamState, onToken);
    }

    this.contextManager.commitAssistantResponse(streamState.fullResponse);
    this.emitDiagnostic({
      type: "iteration_finished",
      provider: this.provider.name,
      model: this.model,
      iteration,
      responseChars: streamState.fullResponse.length,
      responseIsEmpty: streamState.fullResponse.trim().length === 0,
      toolCalls: 0,
    });

    if (streamState.fullResponse.trim().length === 0) {
      this.emitDiagnostic({
        type: "empty_response",
        provider: this.provider.name,
        model: this.model,
        iteration,
        contextMessages: this.contextManager.messageCount,
      });
    }

    return streamState.fullResponse;
  }

  private async requestFinalResponseWithoutTools(
    onToken: (token: string) => void,
    abortSignal: AbortSignal | undefined,
    iteration: number,
    options?: AgentEventOptions,
  ): Promise<string> {
    const noToolsInstruction =
      "Do not call tools. Provide the best final answer from the gathered context. If context is insufficient, explain what is missing briefly.";

    let retryLevel = 0;
    let shrinkCount = 0;

    while (retryLevel <= Agent.MAX_CONTEXT_RETRY_LEVEL) {
      const plan = this.buildPlan(noToolsInstruction, retryLevel, iteration);
      const messages = plan.messages as ChatMessage[];
      this.emitPromptPlanAndRequestStartedDiagnostics(
        plan,
        messages,
        iteration,
        0,
        options,
      );

      try {
        return await this.streamFinalResponseWithoutTools(
          messages,
          onToken,
          abortSignal,
          iteration,
          options,
        );
      } catch (error) {
        if (!(error instanceof ProviderContextLengthError)) throw error;
        const retryAction = await this.handleContextLengthError(
          plan,
          retryLevel,
          shrinkCount,
          iteration,
        );
        if (retryAction.action === "rethrow") throw error;
        retryLevel = retryAction.contextRetryLevel;
        shrinkCount = retryAction.synchronousShrinkCount;
        continue;
      }
    }

    throw new Error("Exhausted all context retry levels");
  }

  private async collectProviderStream(
    messages: ChatMessage[],
    allowedTools: ReadonlySet<string> | undefined,
    iteration: number,
    options: AgentToolOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<{
    fullResponse: string;
    toolCalls?: ChatToolCall[];
    reasoningContent?: string;
    providerReasoningSummary: TurnReasoningSummary | null;
    stopReason?: string;
  }> {
    const streamState = { fullResponse: "", chunkCount: 0 };
    let toolCalls: ChatToolCall[] | undefined;
    let reasoningContent: string | undefined;
    let providerReasoningSummary: TurnReasoningSummary | null = null;
    let stopReason: string | undefined;

    this.emitStatus(options, "Streaming response", "response");

    for await (const event of this.withStreamIdleWatchdog(
      this.provider.streamChat({
        model: this.model,
        messages,
        tools: this.getMergedToolSchemas(allowedTools),
        signal: options?.abortSignal,
        iteration,
      }),
      iteration,
    )) {
      const normalizedEvent = this.normalizeAndEmitStreamEvent(
        event,
        options,
        options?.abortSignal,
      );
      if (
        normalizedEvent.reasoningSummary &&
        !providerReasoningSummary &&
        normalizedEvent.reasoningSummary.summary.trim().length > 0
      ) {
        providerReasoningSummary = normalizedEvent.reasoningSummary;
      }

      this.recordStreamChunk(normalizedEvent, iteration, streamState, onToken);

      if (normalizedEvent.toolCalls) {
        toolCalls = normalizedEvent.toolCalls;
        reasoningContent = normalizedEvent.reasoningContent;
      }

      if (normalizedEvent.stopReason) {
        stopReason = normalizedEvent.stopReason;
      }
    }

    return {
      fullResponse: streamState.fullResponse,
      toolCalls,
      reasoningContent,
      providerReasoningSummary,
      stopReason,
    };
  }

  private async *withStreamIdleWatchdog(
    source: AsyncIterable<ChatStreamEvent>,
    iteration: number,
  ): AsyncIterable<ChatStreamEvent> {
    const timeoutMs = this.runtimeConfig.streamIdleTimeoutMs;
    if (timeoutMs <= 0) {
      yield* source;
      return;
    }

    const iter = source[Symbol.asyncIterator]();
    try {
      while (true) {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            this.emitDiagnostic({
              type: "stream_idle_aborted",
              provider: this.provider.name,
              model: this.model,
              iteration,
              timeoutMs,
            });
            reject(new Error(`Stream idle timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        });

        try {
          const result = await Promise.race([iter.next(), timeoutPromise]);
          clearTimeout(timeoutHandle);
          if (result.done) return;
          yield result.value;
        } catch (err) {
          clearTimeout(timeoutHandle);
          throw err;
        }
      }
    } finally {
      await iter.return?.();
    }
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

  private async executeToolCalls(
    toolCallsToExecute: ChatToolCall[],
    allowedTools: ReadonlySet<string> | undefined,
    iteration: number,
    options: AgentToolOptions | undefined,
    onToken: (token: string) => void,
    toolExecutionEvents: Array<{ name: string; failed: boolean }>,
  ): Promise<void> {
    this.pendingToolResultBytes = 0;
    const artifactToolResults: ArtifactToolResult[] = [];

    for (const toolCall of toolCallsToExecute) {
      const raw = await this.processToolCall(
        toolCall,
        allowedTools,
        iteration,
        options,
        onToken,
        toolExecutionEvents,
      );
      artifactToolResults.push(this.maybePersistedResult(raw));
    }

    this.contextManager.recordToolResults(artifactToolResults);
  }

  private async processToolCall(
    toolCall: ChatToolCall,
    allowedTools: ReadonlySet<string> | undefined,
    iteration: number,
    options: AgentToolOptions | undefined,
    onToken: (token: string) => void,
    toolExecutionEvents: Array<{ name: string; failed: boolean }>,
  ): Promise<ArtifactToolResult> {
    if (options?.abortSignal?.aborted) {
      throw new Error("Request cancelled");
    }

    const args = toolCall.function.arguments;
    const safeArgs = args ?? {};
    const toolName = toolCall.function.name;
    const serializedArgs = JSON.stringify(safeArgs);
    const toolCallId = toolCall.id!;
    const activityLabel = this.describeToolInvocation(toolName, safeArgs);

    this.emitToolStartedDiagnostics(
      toolName,
      toolCallId,
      activityLabel,
      safeArgs,
      serializedArgs,
      iteration,
      options,
    );
    options?.onToolStart?.(toolName);

    const execResult = await this.executeToolWithStatus(
      toolName,
      args,
      allowedTools,
    );
    const result = execResult.content;
    const failed = this.emitToolFinishedEvents(
      toolName,
      toolCallId,
      activityLabel,
      safeArgs,
      result,
      execResult,
      iteration,
      options,
    );

    if (!failed) {
      this.recordSkillTouchFromToolArgs(toolName, args);
    }
    toolExecutionEvents.push({ name: toolName, failed });

    return {
      toolCallId,
      toolName,
      rawContent: result,
      status: failed ? "error" : "success",
    };
  }

  private emitToolStartedDiagnostics(
    toolName: string,
    toolCallId: string,
    activityLabel: string,
    args: Record<string, unknown>,
    serializedArgs: string,
    iteration: number,
    options: AgentToolOptions | undefined,
  ): void {
    this.emitStatus(options, "Running tool", "tool");
    this.emitVisibilityEvent(options, {
      type: "tool_started",
      toolName,
      toolCallId,
      activityLabel,
      useLabel: this.toolRegistry.hasTool(toolName)
        ? this.toolRegistry.renderInvocationUse(toolName, args)
        : null,
      args,
      argumentChars: serializedArgs.length,
      argumentPreview: this.toPreview(serializedArgs),
    });
    this.emitDiagnostic({
      type: "tool_execution_started",
      provider: this.provider.name,
      model: this.model,
      iteration,
      toolName,
      toolCallId,
      argsChars: serializedArgs.length,
    });
  }

  private emitToolFinishedEvents(
    toolName: string,
    toolCallId: string,
    activityLabel: string,
    args: Record<string, unknown>,
    result: string,
    execResult: ToolExecutionResult,
    iteration: number,
    options: AgentToolOptions | undefined,
  ): boolean {
    const failed = execResult.status !== "success";
    this.emitDiagnostic({
      type: "tool_execution_finished",
      provider: this.provider.name,
      model: this.model,
      iteration,
      toolName,
      toolCallId,
      resultChars: result.length,
      truncatedForContext: false,
      status: execResult.status,
    });
    const resultPreview =
      !failed && this.toolRegistry.hasTool(toolName)
        ? this.toolRegistry.renderInvocationResult(toolName, args, result)
        : this.toPreview(result);
    this.emitVisibilityEvent(options, {
      type: failed ? "tool_failed" : "tool_finished",
      toolName,
      toolCallId,
      activityLabel,
      resultPreview,
    });
    options?.onToolEnd?.(toolName, result, execResult.status);
    return failed;
  }

  private async finalizeWithNoToolsResponse(
    onToken: (token: string) => void,
    options: AgentStreamOptions | undefined,
    iterationCount: number,
    emptyToolOnlyStreak: number,
    emptyResponseErrorMessage: string,
  ): Promise<{
    finalResponse: string;
    continueLoop: boolean;
    emptyToolOnlyStreak: number;
    hasFinalAssistantResponse: boolean;
  }> {
    this.contextManager.removeLastUnresolvedAssistantMessage();

    const finalResponse = await this.requestFinalResponseWithoutTools(
      onToken,
      options?.abortSignal,
      iterationCount + 1,
      options,
    );
    if (finalResponse.trim().length === 0) {
      throw new Error(emptyResponseErrorMessage);
    }

    return {
      finalResponse,
      continueLoop: false,
      emptyToolOnlyStreak,
      hasFinalAssistantResponse: true,
    };
  }

  private emitToolCallsReceivedDiagnostic(
    options: AgentStreamOptions | undefined,
    iterationCount: number,
    toolCalls: ChatToolCall[],
  ): void {
    if (toolCalls.length === 0) return;

    this.emitStatus(options, "Tool call received", "tool");
    this.emitDiagnostic({
      type: "tool_calls_received",
      provider: this.provider.name,
      model: this.model,
      iteration: iterationCount,
      count: toolCalls.length,
      tools: toolCalls.map((toolCall) => toolCall.function.name),
    });
  }

  private async handleChatTurnResponse(
    fullResponse: string,
    toolCalls: ChatToolCall[] | undefined,
    reasoningContent: string | undefined,
    iterationCount: number,
    options: AgentStreamOptions | undefined,
    onToken: (token: string) => void,
    allowedTools: ReadonlySet<string> | undefined,
    emptyToolOnlyStreak: number,
    toolExecutionEvents: Array<{ name: string; failed: boolean }>,
  ): Promise<{
    finalResponse: string;
    continueLoop: boolean;
    emptyToolOnlyStreak: number;
    hasFinalAssistantResponse: boolean;
  }> {
    const normalizedToolCalls = this.normalizeToolCallIds(
      toolCalls,
      iterationCount,
    );
    const toolCallsToExecute = normalizedToolCalls ?? [];
    const hasToolCalls = toolCallsToExecute.length > 0;
    this.emitToolCallsReceivedDiagnostic(
      options,
      iterationCount,
      toolCallsToExecute,
    );

    this.contextManager.commitAssistantResponse(
      fullResponse,
      normalizedToolCalls,
      hasToolCalls ? { reasoningContent } : undefined,
    );
    this.emitTurnFinishedDiagnostics(
      fullResponse,
      iterationCount,
      normalizedToolCalls,
    );

    const isEmptyResponse = fullResponse.trim().length === 0;
    const nextEmptyToolOnlyStreak =
      hasToolCalls && isEmptyResponse ? emptyToolOnlyStreak + 1 : 0;

    if (hasToolCalls) {
      const loopResult = await this.checkLoopAndFinalize(
        toolCallsToExecute,
        nextEmptyToolOnlyStreak,
        onToken,
        options,
        iterationCount,
        toolExecutionEvents,
      );
      if (loopResult !== null) return loopResult;

      onToken("\n");
      await this.executeToolCalls(
        toolCallsToExecute,
        allowedTools,
        iterationCount,
        options,
        onToken,
        toolExecutionEvents,
      );

      this.emitStatus(options, "Processing tool results", "tool");
      onToken("\n");
      return {
        finalResponse: fullResponse,
        continueLoop: true,
        emptyToolOnlyStreak: nextEmptyToolOnlyStreak,
        hasFinalAssistantResponse: false,
      };
    }

    this.emitStatus(options, "Generating final answer", "answer");
    return {
      finalResponse: fullResponse,
      continueLoop: false,
      emptyToolOnlyStreak: nextEmptyToolOnlyStreak,
      hasFinalAssistantResponse: true,
    };
  }

  private normalizeToolCallIds(
    toolCalls: ChatToolCall[] | undefined,
    iterationCount: number,
  ): ChatToolCall[] | undefined {
    return toolCalls?.map((toolCall, index) => ({
      ...toolCall,
      id: toolCall.id || `toolcall_${iterationCount}_${index}`,
    }));
  }

  private emitTurnFinishedDiagnostics(
    fullResponse: string,
    iterationCount: number,
    normalizedToolCalls: ChatToolCall[] | undefined,
  ): void {
    this.emitDiagnostic({
      type: "iteration_finished",
      provider: this.provider.name,
      model: this.model,
      iteration: iterationCount,
      responseChars: fullResponse.length,
      responseIsEmpty: fullResponse.trim().length === 0,
      toolCalls: normalizedToolCalls?.length ?? 0,
    });

    if (
      fullResponse.trim().length === 0 &&
      (!normalizedToolCalls || normalizedToolCalls.length === 0)
    ) {
      this.emitDiagnostic({
        type: "empty_response",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        contextMessages: this.contextManager.messageCount,
      });
    }
  }

  private async checkLoopAndFinalize(
    toolCallsToExecute: ChatToolCall[],
    nextEmptyToolOnlyStreak: number,
    onToken: (token: string) => void,
    options: AgentStreamOptions | undefined,
    iterationCount: number,
    toolExecutionEvents: Array<{ name: string; failed: boolean }>,
  ): Promise<{
    finalResponse: string;
    continueLoop: boolean;
    emptyToolOnlyStreak: number;
    hasFinalAssistantResponse: boolean;
  } | null> {
    void toolExecutionEvents;
    if (this.runtimeConfig.useNoProgressDetector) {
      if (!this.detectNoProgress(toolCallsToExecute)) return null;
      this.emitDiagnostic({
        type: "no_progress_detected",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        lookbackIterations: 5,
      });
      return this.finalizeWithNoToolsResponse(
        onToken,
        options,
        iterationCount,
        nextEmptyToolOnlyStreak,
        "Stopped after no-progress detection with no final assistant response.",
      );
    }

    if (nextEmptyToolOnlyStreak < Agent.MAX_EMPTY_TOOL_ONLY_STREAK) return null;
    this.emitDiagnostic({
      type: "tool_loop_detected",
      provider: this.provider.name,
      model: this.model,
      iteration: iterationCount,
      emptyToolOnlyStreak: nextEmptyToolOnlyStreak,
      threshold: Agent.MAX_EMPTY_TOOL_ONLY_STREAK,
      action: "fallback_no_tools",
    });
    return this.finalizeWithNoToolsResponse(
      onToken,
      options,
      iterationCount,
      nextEmptyToolOnlyStreak,
      "Stopped after repeated empty tool-calling turns with no final assistant response.",
    );
  }

  private async handleMaxTokensRecovery(
    initialResult: {
      fullResponse: string;
      toolCalls?: ChatToolCall[];
      reasoningContent?: string;
      stopReason?: string;
    },
    messages: ChatMessage[],
    allowedTools: ReadonlySet<string> | undefined,
    iterationCount: number,
    options: AgentStreamOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<{
    fullResponse: string;
    toolCalls?: ChatToolCall[];
    reasoningContent?: string;
  }> {
    let { fullResponse, toolCalls, reasoningContent } = initialResult;

    if (
      initialResult.stopReason !== "max_tokens" ||
      this.runtimeConfig.outputTokenRecoveryLimit <= 0
    ) {
      return { fullResponse, toolCalls, reasoningContent };
    }

    let recoveryAttempts = 0;
    let currentStopReason = initialResult.stopReason;

    while (
      recoveryAttempts < this.runtimeConfig.outputTokenRecoveryLimit &&
      currentStopReason === "max_tokens"
    ) {
      recoveryAttempts++;
      this.emitDiagnostic({
        type: "output_token_recovery_attempt",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        attemptNumber: recoveryAttempts,
      });

      const continuationMessages = [...messages];
      if (fullResponse.trim().length > 0) {
        continuationMessages.push({ role: "assistant", content: fullResponse });
      }
      continuationMessages.push({
        role: "user",
        content:
          "Continue with more detail if needed. If the response is complete, just reply with a period.",
      });

      const continuationResult = await this.collectProviderStream(
        continuationMessages,
        allowedTools,
        iterationCount,
        options,
        onToken,
      );

      fullResponse += continuationResult.fullResponse;
      if (continuationResult.toolCalls) {
        toolCalls = continuationResult.toolCalls;
        reasoningContent = continuationResult.reasoningContent;
      }
      currentStopReason = continuationResult.stopReason ?? currentStopReason;
    }

    if (currentStopReason === "max_tokens") {
      this.emitDiagnostic({
        type: "output_token_recovery_exhausted",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        maxAttempts: this.runtimeConfig.outputTokenRecoveryLimit,
      });
    }

    return { fullResponse, toolCalls, reasoningContent };
  }

  private async handleContextLengthError(
    plan: PromptPlan,
    contextRetryLevel: number,
    synchronousShrinkCount: number,
    iterationCount: number,
  ): Promise<
    | { action: "rethrow" }
    | {
        action: "retry";
        contextRetryLevel: number;
        synchronousShrinkCount: number;
      }
  > {
    if (contextRetryLevel >= Agent.MAX_CONTEXT_RETRY_LEVEL) {
      this.emitDiagnostic({
        type: "context_pressure_circuit_breaker",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        retryLevel: contextRetryLevel,
      });
      return { action: "rethrow" };
    }

    synchronousShrinkCount++;
    if (synchronousShrinkCount > Agent.MAX_CONTEXT_RETRY_LEVEL + 1) {
      this.emitDiagnostic({
        type: "context_pressure_circuit_breaker",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        retryLevel: contextRetryLevel,
      });
      return { action: "rethrow" };
    }

    const shrunk = await this.attemptSynchronousShrink(plan);
    if (shrunk) {
      this.emitDiagnostic({
        type: "provider_error",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        errorName: "ProviderContextLengthError",
        message: `Context length exceeded, retrying after synchronous summary refresh at level ${contextRetryLevel}`,
      });
      return { action: "retry", contextRetryLevel, synchronousShrinkCount };
    }

    contextRetryLevel++;
    this.emitDiagnostic({
      type: "provider_error",
      provider: this.provider.name,
      model: this.model,
      iteration: iterationCount,
      errorName: "ProviderContextLengthError",
      message: `Context length exceeded, retrying at level ${contextRetryLevel}`,
    });
    return { action: "retry", contextRetryLevel, synchronousShrinkCount };
  }

  private validateTurnCompletion(
    continueLoop: boolean,
    iterationCount: number,
    maxIterations: number,
    toolCalls: ChatToolCall[] | undefined,
    hasFinalAssistantResponse: boolean,
    finalResponse: string,
    toolExecutionEvents: Array<{ name: string; failed: boolean }>,
  ): void {
    if (!continueLoop || iterationCount < maxIterations) return;

    const failedTools = Array.from(
      new Set(
        toolExecutionEvents
          .filter((event) => event.failed)
          .map((event) => event.name),
      ),
    );
    const failedToolCount = toolExecutionEvents.filter(
      (event) => event.failed,
    ).length;
    this.emitDiagnostic({
      type: "max_iterations_reached",
      provider: this.provider.name,
      model: this.model,
      maxIterations,
      iterationsCompleted: iterationCount,
      pendingToolCalls: toolCalls?.length ?? 0,
      failedToolCount,
      failedTools,
    });
    if (!hasFinalAssistantResponse || finalResponse.trim().length === 0) {
      const failedToolsSuffix =
        failedTools.length > 0
          ? ` Failed tools: ${failedTools.join(", ")}.`
          : "";
      throw new Error(
        `Stopped after reaching max iterations before a final assistant response. The last output may be incomplete.${failedToolsSuffix}`,
      );
    }
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

  private selectTurnReasoningSummary(
    agentSummary: string,
    providerReasoningSummary: TurnReasoningSummary | null,
  ): TurnReasoningSummary {
    if (agentSummary.trim().length > 0) {
      return { summary: agentSummary, source: "agent" };
    }

    return (
      providerReasoningSummary ?? {
        summary: "Completed the request and generated the final response.",
        source: "agent",
      }
    );
  }

  private async runOneIteration(
    messages: ChatMessage[],
    allowedTools: ReadonlySet<string> | undefined,
    iterationCount: number,
    options: AgentStreamOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<{
    fullResponse: string;
    toolCalls?: ChatToolCall[];
    reasoningContent?: string;
    providerReasoningSummary: TurnReasoningSummary | null;
  }> {
    const streamResult = await this.collectProviderStream(
      messages,
      allowedTools,
      iterationCount,
      options,
      onToken,
    );
    const recovered = await this.handleMaxTokensRecovery(
      streamResult,
      messages,
      allowedTools,
      iterationCount,
      options,
      onToken,
    );
    return {
      ...recovered,
      providerReasoningSummary: streamResult.providerReasoningSummary,
    };
  }

  // Orchestration loop: while + nested context-length retry handling is structural;
  // business logic is extracted to dedicated helpers.
  // fallow-ignore-next-line complexity
  async streamChat(
    userMessage: string,
    onToken: (token: string) => void,
    options?: AgentStreamOptions,
  ): Promise<string> {
    if (options?.abortSignal?.aborted) {
      throw new Error("Request cancelled");
    }

    this.contextManager.beginUserTurn(userMessage);
    await this.attachFileMentions(userMessage);
    this.lastTurnReasoningSummary = null;
    this.emitStatus(options, "Preparing request", "request");

    let iterationCount = 0;
    let contextRetryLevel = 0;
    let synchronousShrinkCount = 0;
    const toolExecutionEvents: Array<{ name: string; failed: boolean }> = [];
    let providerReasoningSummary: TurnReasoningSummary | null = null;
    const extraUserInstruction = this.normalizeExtraInstruction(options);
    let fullResponse = "";
    let toolCalls: ChatToolCall[] | undefined;
    let reasoningContent: string | undefined;

    // Get sessions dir for in-progress marker management (available to both try and catch)
    const sessionsDir = getDefaultSessionsDir();
    this.sessionsDir = sessionsDir;

    try {
      // Write in-progress marker at turn start (Phase 7 crash telemetry)
      const inProgressMarker: InProgressMarker = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        providerName: this.provider.name,
        modelKey: this.model,
        turnIndex: iterationCount,
      };
      writeInProgressMarker(sessionsDir, this.sessionId, inProgressMarker);

      let finalResponse = "";
      let continueLoop = true;
      let hasFinalAssistantResponse = false;
      const maxIterations =
        options?.maxIterations ?? this.runtimeConfig.maxIterations;
      let emptyToolOnlyStreak = 0;

      while (continueLoop && iterationCount < maxIterations) {
        iterationCount++;
        const activeSkillScopes = this.getActiveSkillScopes();
        const allowedTools = this.deriveAllowedToolScope(activeSkillScopes);

        const plan = this.buildPlan(
          extraUserInstruction,
          contextRetryLevel,
          iterationCount,
        );
        const messages = plan.messages as ChatMessage[];
        this.emitPromptPlanAndRequestStartedDiagnostics(
          plan,
          messages,
          iterationCount,
          this.getMergedToolSchemas(allowedTools).length,
          options,
        );

        try {
          const iterationResult = await this.runOneIteration(
            messages,
            allowedTools,
            iterationCount,
            options,
            onToken,
          );
          providerReasoningSummary = iterationResult.providerReasoningSummary;
          fullResponse = iterationResult.fullResponse;
          toolCalls = iterationResult.toolCalls;
          reasoningContent = iterationResult.reasoningContent;
        } catch (streamError) {
          if (!(streamError instanceof ProviderContextLengthError)) {
            throw streamError;
          }
          const retryAction = await this.handleContextLengthError(
            plan,
            contextRetryLevel,
            synchronousShrinkCount,
            iterationCount,
          );
          if (retryAction.action === "rethrow") throw streamError;
          contextRetryLevel = retryAction.contextRetryLevel;
          synchronousShrinkCount = retryAction.synchronousShrinkCount;
          iterationCount--;
          continue;
        }

        contextRetryLevel = 0;
        const turnResult = await this.handleChatTurnResponse(
          fullResponse,
          toolCalls,
          reasoningContent,
          iterationCount,
          options,
          onToken,
          allowedTools,
          emptyToolOnlyStreak,
          toolExecutionEvents,
        );
        finalResponse = turnResult.finalResponse;
        continueLoop = turnResult.continueLoop;
        emptyToolOnlyStreak = turnResult.emptyToolOnlyStreak;
        hasFinalAssistantResponse = turnResult.hasFinalAssistantResponse;
      }

      this.validateTurnCompletion(
        continueLoop,
        iterationCount,
        maxIterations,
        toolCalls,
        hasFinalAssistantResponse,
        finalResponse,
        toolExecutionEvents,
      );

      const agentSummary = this.synthesizeAgentReasoningSummary(
        iterationCount,
        toolExecutionEvents,
      );
      const selectedReasoningSummary = this.selectTurnReasoningSummary(
        agentSummary,
        providerReasoningSummary,
      );

      this.lastTurnReasoningSummary = selectedReasoningSummary;
      this.emitVisibilityEvent(options, {
        type: "reasoning_summary",
        summary: selectedReasoningSummary.summary,
        source: selectedReasoningSummary.source,
      });

      this.checkAndScheduleSummary();

      // Clear in-progress marker on clean turn completion
      clearInProgressMarker(sessionsDir, this.sessionId);

      return finalResponse;
    } catch (error) {
      this.emitDiagnostic({
        type: "provider_error",
        provider: this.provider.name,
        model: this.model,
        iteration: iterationCount,
        errorName: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      });
      // Clear marker before rethrowing (so next error doesn't double-clear)
      try {
        clearInProgressMarker(sessionsDir, this.sessionId);
      } catch {
        // Ignore marker clearing errors
      }
      throw this.handleProviderError(error);
    }
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
  exportSession(): string {
    const state = this.contextManager.getConversationState();
    const metadata: SessionMetadata = {
      providerName: this.provider.name,
      modelKey: this.model,
      systemPrompt: this.systemPrompt,
      promptBudgetPolicy: DEFAULT_BUDGET_POLICY,
      summaryPolicy: this.summaryPolicy,
      contextWindowTokens: this.resolveContextWindowTokens(),
      sessionId: this.sessionId,
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
      (this as any).sessionId = persisted.metadata.sessionId;
    } else {
      this.emitDiagnostic({
        type: "legacy_session_no_id",
        provider: this.provider.name,
        model: this.model,
      });
    }

    this.contextManager.importState(state);
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
    this.systemPrompt = prompt;
  }

  getTools(): ChatTool[] {
    return this.getMergedToolSchemas();
  }

  getToolSummaries(): ReadonlyArray<ToolSummary> {
    return this.toolRegistry.getToolSummaries();
  }

  addTool(tool: ExecutableTool): void {
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
