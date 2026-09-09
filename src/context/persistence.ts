import {
  SessionParseError,
  assertObject,
  assertArray,
  assertString,
  assertNumber,
  validateOptionalStringFields,
  validateStringArrayField,
  validateConversationState,
  encodeConversationState,
  decodeConversationState,
  type PersistedChatMessage,
  type PersistedTurnRecord,
  type PersistedArtifactRecord,
  type PersistedPinnedMemoryRecord,
} from "./codec.js";
export { SessionParseError } from "./codec.js";
import {
  ConversationState,
  RollingSummaryRecord,
  PromptBudgetPolicy,
  SummaryPolicy,
} from "./types.js";
import type { SkillInvocationScope } from "../skills/types.js";
import type { InvokedSkillRecord } from "../skills/types.js";
import type { AgentMode } from "../modes/types.js";

// ---------------------------------------------------------------------------
// Persisted types (JSON-safe representations)
// ---------------------------------------------------------------------------

export interface SessionMetadata {
  readonly providerName: string;
  readonly modelKey: string;
  readonly systemPrompt: string;
  readonly promptBudgetPolicy: PromptBudgetPolicy;
  readonly summaryPolicy: SummaryPolicy;
  readonly contextWindowTokens: number;
  readonly sessionId?: string;
  readonly agentMode?: AgentMode;
  readonly planFilePath?: string;
  readonly planSaveApproved?: boolean;
  readonly planDraftSearchStartTurnIndex?: number;
}

export interface PersistedSessionV1 {
  readonly version: 1;
  readonly savedAt: string;
  readonly metadata: SessionMetadata;
  readonly context: {
    readonly preamble: ReadonlyArray<PersistedChatMessage>;
    readonly turns: ReadonlyArray<PersistedTurnRecord>;
    readonly rollingSummary?: RollingSummaryRecord;
    readonly artifacts: ReadonlyArray<PersistedArtifactRecord>;
  };
}

export interface PersistedSkillInvocationScope {
  readonly invocationSource: SkillInvocationScope["invocationSource"];
  readonly skillName: string;
  readonly skillRoot: string;
  readonly skillFile: string;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly model?: string;
  readonly effort?: string;
  readonly appliedModel?: string;
  readonly warnings?: ReadonlyArray<string>;
}

export interface PersistedInvokedSkillRecord {
  readonly name: string;
  readonly source: InvokedSkillRecord["source"];
  readonly skillRoot: string;
  readonly skillFile: string;
  readonly arguments?: string;
  readonly content: string;
  readonly invokedAt: string;
  readonly scope: PersistedSkillInvocationScope;
}

export interface PersistedSessionV2 {
  readonly version: 2;
  readonly savedAt: string;
  readonly metadata: SessionMetadata;
  readonly context: {
    readonly preamble: ReadonlyArray<PersistedChatMessage>;
    readonly turns: ReadonlyArray<PersistedTurnRecord>;
    readonly rollingSummary?: RollingSummaryRecord;
    readonly artifacts: ReadonlyArray<PersistedArtifactRecord>;
    readonly pinnedMemory: ReadonlyArray<PersistedPinnedMemoryRecord>;
  };
}

export interface PersistedSessionV3 {
  readonly version: 3;
  readonly savedAt: string;
  readonly metadata: SessionMetadata;
  readonly context: {
    readonly preamble: ReadonlyArray<PersistedChatMessage>;
    readonly turns: ReadonlyArray<PersistedTurnRecord>;
    readonly rollingSummary?: RollingSummaryRecord;
    readonly artifacts: ReadonlyArray<PersistedArtifactRecord>;
    readonly pinnedMemory: ReadonlyArray<PersistedPinnedMemoryRecord>;
    readonly invokedSkills: ReadonlyArray<PersistedInvokedSkillRecord>;
  };
}

export interface PersistedSessionV4 {
  readonly version: 4;
  readonly savedAt: string;
  readonly metadata: SessionMetadata;
  readonly context: {
    readonly preamble: ReadonlyArray<PersistedChatMessage>;
    readonly turns: ReadonlyArray<PersistedTurnRecord>;
    readonly rollingSummary?: RollingSummaryRecord;
    readonly artifacts: ReadonlyArray<PersistedArtifactRecord>;
    readonly pinnedMemory: ReadonlyArray<PersistedPinnedMemoryRecord>;
    readonly invokedSkills: ReadonlyArray<PersistedInvokedSkillRecord>;
  };
}

// ---------------------------------------------------------------------------
// Serialization (runtime → persisted JSON string)
// ---------------------------------------------------------------------------

function persistSkillScope(
  scope: SkillInvocationScope,
): PersistedSkillInvocationScope {
  const result: Record<string, unknown> = {
    invocationSource: scope.invocationSource,
    skillName: scope.skillName,
    skillRoot: scope.skillRoot,
    skillFile: scope.skillFile,
  };
  if (scope.allowedTools !== undefined) {
    result.allowedTools = [...scope.allowedTools];
  }
  if (scope.model !== undefined) result.model = scope.model;
  if (scope.effort !== undefined) result.effort = scope.effort;
  if (scope.appliedModel !== undefined)
    result.appliedModel = scope.appliedModel;
  if (scope.warnings !== undefined) result.warnings = [...scope.warnings];
  return result as unknown as PersistedSkillInvocationScope;
}

function persistInvokedSkill(
  record: InvokedSkillRecord,
): PersistedInvokedSkillRecord {
  const result: Record<string, unknown> = {
    name: record.name,
    source: record.source,
    skillRoot: record.skillRoot,
    skillFile: record.skillFile,
    content: record.content,
    invokedAt: record.invokedAt,
    scope: persistSkillScope(record.scope),
  };
  if (record.arguments !== undefined) result.arguments = record.arguments;
  return result as unknown as PersistedInvokedSkillRecord;
}

export function serializeSession(
  state: ConversationState,
  metadata: SessionMetadata,
): string {
  const persisted: PersistedSessionV4 = {
    version: 4,
    savedAt: new Date().toISOString(),
    metadata: { ...metadata },
    context: {
      ...encodeConversationState(state),
      invokedSkills: (state.invokedSkills ?? []).map(persistInvokedSkill),
    },
  };
  return JSON.stringify(persisted, null, 2);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_SKILL_INVOCATION_SOURCES = new Set(["user", "model"]);

function validateSkillScope(scope: unknown, label: string): void {
  assertObject(scope, label);
  const obj = scope as Record<string, unknown>;
  assertString(obj.invocationSource, `${label}.invocationSource`);
  if (!VALID_SKILL_INVOCATION_SOURCES.has(obj.invocationSource as string)) {
    throw new SessionParseError(
      `${label}.invocationSource must be one of: user, model`,
    );
  }
  assertString(obj.skillName, `${label}.skillName`);
  assertString(obj.skillRoot, `${label}.skillRoot`);
  assertString(obj.skillFile, `${label}.skillFile`);
  validateStringArrayField(obj, "allowedTools", label);
  validateOptionalStringFields(obj, ["model", "effort", "appliedModel"], label);
  validateStringArrayField(obj, "warnings", label);
}

function validateInvokedSkillRecord(record: unknown, label: string): void {
  assertObject(record, label);
  assertString(record.name, `${label}.name`);
  assertString(record.source, `${label}.source`);
  assertString(record.skillRoot, `${label}.skillRoot`);
  assertString(record.skillFile, `${label}.skillFile`);
  assertString(record.content, `${label}.content`);
  assertString(record.invokedAt, `${label}.invokedAt`);
  validateSkillScope(
    (record as Record<string, unknown>).scope,
    `${label}.scope`,
  );
  const rec = record as Record<string, unknown>;
  if (rec.arguments !== undefined) {
    assertString(rec.arguments, `${label}.arguments`);
  }
}

const VALID_AGENT_MODES = new Set<AgentMode>(["execute", "plan", "discover"]);

function validateAgentModeMetadata(meta: Record<string, unknown>): void {
  if (meta.agentMode === undefined) {
    return;
  }

  assertString(meta.agentMode, "metadata.agentMode");
  if (!VALID_AGENT_MODES.has(meta.agentMode as AgentMode)) {
    throw new SessionParseError(
      `metadata.agentMode must be execute, plan, or discover`,
    );
  }
}

function validatePlanMetadata(meta: Record<string, unknown>): void {
  if (meta.planFilePath !== undefined) {
    assertString(meta.planFilePath, "metadata.planFilePath");
  }
  if (meta.planSaveApproved !== undefined) {
    if (typeof meta.planSaveApproved !== "boolean") {
      throw new SessionParseError(
        "metadata.planSaveApproved must be a boolean",
      );
    }
  }
  if (meta.planFilePath !== undefined && meta.planSaveApproved === false) {
    throw new SessionParseError(
      "metadata.planFilePath requires metadata.planSaveApproved to be true",
    );
  }
}

function validatePlanDraftMetadata(meta: Record<string, unknown>): void {
  if (meta.planDraftSearchStartTurnIndex === undefined) {
    return;
  }

  assertNumber(
    meta.planDraftSearchStartTurnIndex,
    "metadata.planDraftSearchStartTurnIndex",
  );
  if (meta.planDraftSearchStartTurnIndex < 0) {
    throw new SessionParseError(
      "metadata.planDraftSearchStartTurnIndex must be >= 0",
    );
  }
}

function validateMetadata(metadata: unknown): void {
  assertObject(metadata, "metadata");
  const meta = metadata as Record<string, unknown>;
  assertString(meta.providerName, "metadata.providerName");
  assertString(meta.modelKey, "metadata.modelKey");
  assertString(meta.systemPrompt, "metadata.systemPrompt");
  assertNumber(meta.contextWindowTokens, "metadata.contextWindowTokens");
  assertObject(meta.promptBudgetPolicy, "metadata.promptBudgetPolicy");
  assertObject(meta.summaryPolicy, "metadata.summaryPolicy");
  if (meta.sessionId !== undefined) {
    assertString(meta.sessionId, "metadata.sessionId");
  }
  validateAgentModeMetadata(meta);
  validatePlanMetadata(meta);
  validatePlanDraftMetadata(meta);
}

// ---------------------------------------------------------------------------
// Parsing (JSON string → validated PersistedSessionV1)
// ---------------------------------------------------------------------------

// fallow-ignore-next-line complexity
export function parseSession(
  json: string,
):
  | PersistedSessionV1
  | PersistedSessionV2
  | PersistedSessionV3
  | PersistedSessionV4 {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SessionParseError("Invalid JSON: could not parse session data");
  }

  assertObject(raw, "session");

  const version = raw.version;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4) {
    throw new SessionParseError(
      `Unsupported session version: ${String(version)}. Supported versions: 1, 2, 3, 4.`,
    );
  }

  assertString(raw.savedAt, "savedAt");
  validateMetadata(raw.metadata);

  validateConversationState(raw.context, version !== 1);
  const ctx = raw.context as unknown as Record<string, unknown>;

  if (version === 3 || version === 4) {
    assertArray(ctx.invokedSkills, "context.invokedSkills");
    for (let i = 0; i < (ctx.invokedSkills as unknown[]).length; i++) {
      validateInvokedSkillRecord(
        (ctx.invokedSkills as unknown[])[i],
        `context.invokedSkills[${i}]`,
      );
    }
    return raw as unknown as PersistedSessionV3 | PersistedSessionV4;
  }

  if (version === 2) {
    return raw as unknown as PersistedSessionV2;
  }

  return raw as unknown as PersistedSessionV1;
}

// ---------------------------------------------------------------------------
// Restoration (PersistedSessionV1 → runtime ConversationState)
// ---------------------------------------------------------------------------

function restoreSkillScope(
  scope: PersistedSkillInvocationScope,
): SkillInvocationScope {
  return {
    invocationSource: scope.invocationSource,
    skillName: scope.skillName,
    skillRoot: scope.skillRoot,
    skillFile: scope.skillFile,
    ...(scope.allowedTools ? { allowedTools: [...scope.allowedTools] } : {}),
    ...(scope.model ? { model: scope.model } : {}),
    ...(scope.effort ? { effort: scope.effort } : {}),
    ...(scope.appliedModel ? { appliedModel: scope.appliedModel } : {}),
    ...(scope.warnings ? { warnings: [...scope.warnings] } : {}),
  };
}

function restoreInvokedSkill(
  record: PersistedInvokedSkillRecord,
): InvokedSkillRecord {
  return {
    name: record.name,
    source: record.source,
    skillRoot: record.skillRoot,
    skillFile: record.skillFile,
    ...(record.arguments ? { arguments: record.arguments } : {}),
    content: record.content,
    invokedAt: record.invokedAt,
    scope: restoreSkillScope(record.scope),
  };
}

export function restoreConversationState(
  persisted:
    | PersistedSessionV1
    | PersistedSessionV2
    | PersistedSessionV3
    | PersistedSessionV4,
): ConversationState {
  const invokedSkills =
    persisted.version === 3 || persisted.version === 4
      ? (persisted as PersistedSessionV3).context.invokedSkills.map(
          restoreInvokedSkill,
        )
      : [];

  return {
    ...decodeConversationState({
      ...persisted.context,
      pinnedMemory:
        persisted.version === 1 ? [] : persisted.context.pinnedMemory,
    }),
    invokedSkills,
  };
}
