import { Buffer } from "buffer";
import {
  ConversationState,
  TurnRecord,
  TurnEntry,
  ArtifactRecord,
  ToolInvocationRecord,
  RollingSummaryRecord,
  PromptBudgetPolicy,
  SummaryPolicy,
  PinnedMemoryRecord,
  MemoryKind,
  MemoryScope,
  MemoryLifecycle,
  MemoryOrigin,
  MemorySource,
} from "./types.js";
import { ChatMessage, ChatToolCall, ToolResult } from "../providers/types.js";
import type { SkillInvocationScope } from "../skills/types.js";
import type { InvokedSkillRecord } from "../skills/types.js";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class SessionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionParseError";
  }
}

// ---------------------------------------------------------------------------
// Persisted types (JSON-safe representations)
// ---------------------------------------------------------------------------

export interface PersistedImage {
  readonly data: string;
  readonly encoding: "utf8" | "base64";
}

export interface PersistedChatMessage {
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly content: string;
  readonly reasoningContent?: string;
  readonly toolCalls?: ReadonlyArray<ChatToolCall>;
  readonly toolCallId?: string;
  readonly toolResults?: ReadonlyArray<ToolResult>;
  readonly images?: ReadonlyArray<PersistedImage>;
}

export interface PersistedTurnEntry {
  readonly kind: "assistant" | "tool";
  readonly createdAt: string;
  readonly estimatedTokens?: number;
  readonly message: PersistedChatMessage;
  readonly toolInvocations?: ReadonlyArray<ToolInvocationRecord>;
}

export interface PersistedTurnRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly importance: "low" | "normal" | "high";
  readonly summary?: string;
  readonly estimatedTokens?: number;
  readonly userMessage: PersistedChatMessage;
  readonly entries: ReadonlyArray<PersistedTurnEntry>;
}

export interface PersistedArtifactRecord {
  readonly id: string;
  readonly type:
    | "tool_result"
    | "file_snapshot"
    | "command_output"
    | "image"
    | "pdf"
    | "other";
  readonly mediaType: string;
  readonly createdAt: string;
  readonly content: string;
  readonly contentEncoding: "utf8" | "base64";
  readonly contentSizeChars: number;
  readonly estimatedTokens?: number;
  readonly referencingTurnIds: ReadonlyArray<string>;
}

export interface SessionMetadata {
  readonly providerName: string;
  readonly modelKey: string;
  readonly systemPrompt: string;
  readonly promptBudgetPolicy: PromptBudgetPolicy;
  readonly summaryPolicy: SummaryPolicy;
  readonly contextWindowTokens: number;
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

export interface PersistedMemorySource {
  readonly origin: MemoryOrigin;
  readonly turnId?: string;
  readonly toolCallId?: string;
}

export interface PersistedPinnedMemoryRecord {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
  readonly content: string;
  readonly source: PersistedMemorySource;
  readonly rationale?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lifecycle: MemoryLifecycle;
  readonly supersededById?: string;
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

// ---------------------------------------------------------------------------
// Serialization (runtime → persisted JSON string)
// ---------------------------------------------------------------------------

function persistImage(img: Uint8Array | string): PersistedImage {
  if (img instanceof Uint8Array) {
    return { data: Buffer.from(img).toString("base64"), encoding: "base64" };
  }
  return { data: img, encoding: "utf8" };
}

function persistMessage(msg: ChatMessage): PersistedChatMessage {
  const result: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };
  if (msg.reasoningContent !== undefined) {
    result.reasoningContent = msg.reasoningContent;
  }
  if (msg.toolCalls) result.toolCalls = msg.toolCalls;
  if (msg.toolCallId !== undefined) result.toolCallId = msg.toolCallId;
  if (msg.toolResults) result.toolResults = msg.toolResults;
  if (msg.images) result.images = msg.images.map(persistImage);
  return result as unknown as PersistedChatMessage;
}

function persistEntry(entry: TurnEntry): PersistedTurnEntry {
  const result: Record<string, unknown> = {
    kind: entry.kind,
    createdAt: entry.createdAt,
    message: persistMessage(entry.message),
  };
  if (entry.estimatedTokens !== undefined)
    result.estimatedTokens = entry.estimatedTokens;
  if (entry.kind === "tool")
    result.toolInvocations = entry.toolInvocations.map((inv) => ({ ...inv }));
  return result as unknown as PersistedTurnEntry;
}

function persistTurn(turn: TurnRecord): PersistedTurnRecord {
  const result: Record<string, unknown> = {
    id: turn.id,
    startedAt: turn.startedAt,
    importance: turn.importance,
    userMessage: persistMessage(turn.userMessage),
    entries: turn.entries.map(persistEntry),
  };
  if (turn.completedAt !== undefined) result.completedAt = turn.completedAt;
  if (turn.summary !== undefined) result.summary = turn.summary;
  if (turn.estimatedTokens !== undefined)
    result.estimatedTokens = turn.estimatedTokens;
  return result as unknown as PersistedTurnRecord;
}

function persistArtifact(artifact: ArtifactRecord): PersistedArtifactRecord {
  const isBinary = artifact.content instanceof Uint8Array;
  return {
    id: artifact.id,
    type: artifact.type,
    mediaType: artifact.mediaType,
    createdAt: artifact.createdAt,
    content: isBinary
      ? Buffer.from(artifact.content as Uint8Array).toString("base64")
      : (artifact.content as string),
    contentEncoding: isBinary ? "base64" : "utf8",
    contentSizeChars: artifact.contentSizeChars,
    estimatedTokens: artifact.estimatedTokens,
    referencingTurnIds: [...artifact.referencingTurnIds],
  };
}

function persistPinnedMemory(
  record: PinnedMemoryRecord,
): PersistedPinnedMemoryRecord {
  const result: Record<string, unknown> = {
    id: record.id,
    kind: record.kind,
    scope: record.scope,
    content: record.content,
    source: { ...record.source },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lifecycle: record.lifecycle,
  };
  if (record.rationale !== undefined) result.rationale = record.rationale;
  if (record.supersededById !== undefined)
    result.supersededById = record.supersededById;
  return result as unknown as PersistedPinnedMemoryRecord;
}

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
  const persisted: PersistedSessionV3 = {
    version: 3,
    savedAt: new Date().toISOString(),
    metadata: { ...metadata },
    context: {
      preamble: state.preamble.map(persistMessage),
      turns: state.turns.map(persistTurn),
      artifacts: state.artifacts.map(persistArtifact),
      pinnedMemory: (state.pinnedMemory ?? []).map(persistPinnedMemory),
      invokedSkills: (state.invokedSkills ?? []).map(persistInvokedSkill),
      ...(state.rollingSummary
        ? {
            rollingSummary: {
              ...state.rollingSummary,
              coveredTurnIds: [...state.rollingSummary.coveredTurnIds],
            },
          }
        : {}),
    },
  };
  return JSON.stringify(persisted, null, 2);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionParseError(`${label} must be a non-null object`);
  }
}

function assertArray(
  value: unknown,
  label: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new SessionParseError(`${label} must be an array`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new SessionParseError(`${label} must be a string`);
  }
}

function assertNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number") {
    throw new SessionParseError(`${label} must be a number`);
  }
}

function validateBase64(content: string, label: string): void {
  const reencoded = Buffer.from(content, "base64").toString("base64");
  if (reencoded !== content) {
    throw new SessionParseError(`Invalid base64 encoding in ${label}`);
  }
}

const VALID_ROLES = new Set(["user", "assistant", "system", "tool"]);
const VALID_ENTRY_KINDS = new Set(["assistant", "tool"]);
const VALID_IMPORTANCE = new Set(["low", "normal", "high"]);
const VALID_CONTENT_ENCODING = new Set(["utf8", "base64"]);
const VALID_MEMORY_KINDS = new Set<MemoryKind>([
  "fact",
  "constraint",
  "decision",
]);
const VALID_MEMORY_SCOPES = new Set<MemoryScope>(["session", "project"]);
const VALID_MEMORY_LIFECYCLES = new Set<MemoryLifecycle>([
  "active",
  "superseded",
  "removed",
]);
const VALID_MEMORY_ORIGINS = new Set<MemoryOrigin>([
  "user",
  "assistant",
  "tool",
  "application",
]);

function validateToolCall(tc: unknown, label: string): void {
  assertObject(tc, label);
  assertObject(tc.function, `${label}.function`);
  const fn = tc.function as Record<string, unknown>;
  assertString(fn.name, `${label}.function.name`);
  if (fn.arguments !== undefined) {
    assertObject(fn.arguments, `${label}.function.arguments`);
  }
}

function validateToolResult(tr: unknown, label: string): void {
  assertObject(tr, label);
  assertString(tr.toolCallId, `${label}.toolCallId`);
  assertString(tr.toolName, `${label}.toolName`);
  assertString(tr.content, `${label}.content`);
}

function validateMessage(msg: unknown, label: string): void {
  assertObject(msg, label);
  assertString(msg.role, `${label}.role`);
  if (!VALID_ROLES.has(msg.role as string)) {
    throw new SessionParseError(
      `${label}.role must be one of: user, assistant, system, tool`,
    );
  }
  assertString(msg.content, `${label}.content`);
  if (msg.reasoningContent !== undefined) {
    assertString(msg.reasoningContent, `${label}.reasoningContent`);
  }

  if (msg.toolCalls !== undefined) {
    assertArray(msg.toolCalls, `${label}.toolCalls`);
    for (let i = 0; i < (msg.toolCalls as unknown[]).length; i++) {
      validateToolCall(
        (msg.toolCalls as unknown[])[i],
        `${label}.toolCalls[${i}]`,
      );
    }
  }

  if (msg.toolResults !== undefined) {
    assertArray(msg.toolResults, `${label}.toolResults`);
    for (let i = 0; i < (msg.toolResults as unknown[]).length; i++) {
      validateToolResult(
        (msg.toolResults as unknown[])[i],
        `${label}.toolResults[${i}]`,
      );
    }
  }

  if (msg.images !== undefined) {
    assertArray(msg.images, `${label}.images`);
    for (let i = 0; i < (msg.images as unknown[]).length; i++) {
      const img = (msg.images as unknown[])[i];
      assertObject(img, `${label}.images[${i}]`);
      const imgObj = img as Record<string, unknown>;
      assertString(imgObj.data, `${label}.images[${i}].data`);
      assertString(imgObj.encoding, `${label}.images[${i}].encoding`);
      if (!VALID_CONTENT_ENCODING.has(imgObj.encoding as string)) {
        throw new SessionParseError(
          `${label}.images[${i}].encoding must be "utf8" or "base64"`,
        );
      }
      if (imgObj.encoding === "base64") {
        validateBase64(imgObj.data as string, `${label}.images[${i}]`);
      }
    }
  }
}

function validateEntry(entry: unknown, label: string): void {
  assertObject(entry, label);
  assertString(entry.kind, `${label}.kind`);
  if (!VALID_ENTRY_KINDS.has(entry.kind as string)) {
    throw new SessionParseError(`${label}.kind must be "assistant" or "tool"`);
  }
  assertString(entry.createdAt, `${label}.createdAt`);
  validateMessage(entry.message, `${label}.message`);

  const msgRole = (entry.message as Record<string, unknown>).role as string;

  if (entry.kind === "tool") {
    if (msgRole !== "tool") {
      throw new SessionParseError(
        `${label} has kind "tool" but message.role is "${msgRole}"; expected "tool"`,
      );
    }

    if (entry.toolInvocations === undefined) {
      throw new SessionParseError(
        `${label} has kind "tool" but is missing required toolInvocations`,
      );
    }

    assertArray(entry.toolInvocations, `${label}.toolInvocations`);
    for (let i = 0; i < (entry.toolInvocations as unknown[]).length; i++) {
      const inv = (entry.toolInvocations as unknown[])[i];
      assertObject(inv, `${label}.toolInvocations[${i}]`);
      const invObj = inv as Record<string, unknown>;
      assertString(
        invObj.toolCallId,
        `${label}.toolInvocations[${i}].toolCallId`,
      );
      assertString(invObj.toolName, `${label}.toolInvocations[${i}].toolName`);
      assertString(invObj.status, `${label}.toolInvocations[${i}].status`);
      assertString(
        invObj.resultSummary,
        `${label}.toolInvocations[${i}].resultSummary`,
      );
      assertString(
        invObj.artifactId,
        `${label}.toolInvocations[${i}].artifactId`,
      );
    }
  } else if (entry.kind === "assistant" && msgRole !== "assistant") {
    throw new SessionParseError(
      `${label} has kind "assistant" but message.role is "${msgRole}"; expected "assistant"`,
    );
  }
}

function validateTurn(turn: unknown, label: string): void {
  assertObject(turn, label);
  assertString(turn.id, `${label}.id`);
  assertString(turn.startedAt, `${label}.startedAt`);
  assertString(turn.importance, `${label}.importance`);
  if (!VALID_IMPORTANCE.has(turn.importance as string)) {
    throw new SessionParseError(
      `${label}.importance must be one of: low, normal, high`,
    );
  }
  validateMessage(turn.userMessage, `${label}.userMessage`);
  assertArray(turn.entries, `${label}.entries`);
  for (let i = 0; i < (turn.entries as unknown[]).length; i++) {
    validateEntry((turn.entries as unknown[])[i], `${label}.entries[${i}]`);
  }
}

function validateArtifact(artifact: unknown, label: string): void {
  assertObject(artifact, label);
  assertString(artifact.id, `${label}.id`);
  assertString(artifact.type, `${label}.type`);
  assertString(artifact.mediaType, `${label}.mediaType`);
  assertString(artifact.createdAt, `${label}.createdAt`);
  assertString(artifact.content, `${label}.content`);
  assertString(artifact.contentEncoding, `${label}.contentEncoding`);
  if (!VALID_CONTENT_ENCODING.has(artifact.contentEncoding as string)) {
    throw new SessionParseError(
      `${label}.contentEncoding must be "utf8" or "base64"`,
    );
  }
  assertNumber(artifact.contentSizeChars, `${label}.contentSizeChars`);
  assertArray(artifact.referencingTurnIds, `${label}.referencingTurnIds`);

  if (artifact.contentEncoding === "base64") {
    validateBase64(artifact.content as string, label);
  }
}

function validateRollingSummary(summary: unknown, label: string): void {
  assertObject(summary, label);
  assertString(summary.content, `${label}.content`);
  assertString(summary.updatedAt, `${label}.updatedAt`);
  assertArray(summary.coveredTurnIds, `${label}.coveredTurnIds`);
  assertNumber(summary.estimatedTokens, `${label}.estimatedTokens`);
}

function validateMemorySource(source: unknown, label: string): void {
  assertObject(source, label);
  assertString(source.origin, `${label}.origin`);
  if (!VALID_MEMORY_ORIGINS.has(source.origin as MemoryOrigin)) {
    throw new SessionParseError(
      `${label}.origin must be one of: user, assistant, tool, application`,
    );
  }
  const src = source as Record<string, unknown>;
  if (src.turnId !== undefined) {
    assertString(src.turnId, `${label}.turnId`);
  }
  if (src.toolCallId !== undefined) {
    assertString(src.toolCallId, `${label}.toolCallId`);
  }
}

function validatePinnedMemoryRecord(record: unknown, label: string): void {
  assertObject(record, label);
  assertString(record.id, `${label}.id`);
  assertString(record.kind, `${label}.kind`);
  if (!VALID_MEMORY_KINDS.has(record.kind as MemoryKind)) {
    throw new SessionParseError(
      `${label}.kind must be one of: fact, constraint, decision`,
    );
  }
  assertString(record.scope, `${label}.scope`);
  if (!VALID_MEMORY_SCOPES.has(record.scope as MemoryScope)) {
    throw new SessionParseError(
      `${label}.scope must be one of: session, project`,
    );
  }
  assertString(record.content, `${label}.content`);
  validateMemorySource(record.source, `${label}.source`);
  assertString(record.createdAt, `${label}.createdAt`);
  assertString(record.updatedAt, `${label}.updatedAt`);
  assertString(record.lifecycle, `${label}.lifecycle`);
  if (!VALID_MEMORY_LIFECYCLES.has(record.lifecycle as MemoryLifecycle)) {
    throw new SessionParseError(
      `${label}.lifecycle must be one of: active, superseded, removed`,
    );
  }
  const rec = record as Record<string, unknown>;
  if (rec.rationale !== undefined) {
    assertString(rec.rationale, `${label}.rationale`);
  }
  if (rec.supersededById !== undefined) {
    assertString(rec.supersededById, `${label}.supersededById`);
  }
  if (record.lifecycle === "superseded" && rec.supersededById === undefined) {
    throw new SessionParseError(
      `${label} has lifecycle "superseded" but is missing required supersededById`,
    );
  }
}

function validateSkillScope(scope: unknown, label: string): void {
  assertObject(scope, label);
  assertString(scope.invocationSource, `${label}.invocationSource`);
  if (scope.invocationSource !== "user" && scope.invocationSource !== "model") {
    throw new SessionParseError(
      `${label}.invocationSource must be one of: user, model`,
    );
  }
  assertString(scope.skillName, `${label}.skillName`);
  assertString(scope.skillRoot, `${label}.skillRoot`);
  assertString(scope.skillFile, `${label}.skillFile`);
  const obj = scope as Record<string, unknown>;
  if (obj.allowedTools !== undefined) {
    assertArray(obj.allowedTools, `${label}.allowedTools`);
    for (let i = 0; i < obj.allowedTools.length; i++) {
      assertString(obj.allowedTools[i], `${label}.allowedTools[${i}]`);
    }
  }
  if (obj.model !== undefined) assertString(obj.model, `${label}.model`);
  if (obj.effort !== undefined) assertString(obj.effort, `${label}.effort`);
  if (obj.appliedModel !== undefined)
    assertString(obj.appliedModel, `${label}.appliedModel`);
  if (obj.warnings !== undefined) {
    assertArray(obj.warnings, `${label}.warnings`);
    for (let i = 0; i < obj.warnings.length; i++) {
      assertString(obj.warnings[i], `${label}.warnings[${i}]`);
    }
  }
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

function validateMetadata(metadata: unknown): void {
  assertObject(metadata, "metadata");
  assertString(metadata.providerName, "metadata.providerName");
  assertString(metadata.modelKey, "metadata.modelKey");
  assertString(metadata.systemPrompt, "metadata.systemPrompt");
  assertNumber(metadata.contextWindowTokens, "metadata.contextWindowTokens");
  assertObject(metadata.promptBudgetPolicy, "metadata.promptBudgetPolicy");
  assertObject(metadata.summaryPolicy, "metadata.summaryPolicy");
}

// ---------------------------------------------------------------------------
// Parsing (JSON string → validated PersistedSessionV1)
// ---------------------------------------------------------------------------

export function parseSession(
  json: string,
): PersistedSessionV1 | PersistedSessionV2 | PersistedSessionV3 {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SessionParseError("Invalid JSON: could not parse session data");
  }

  assertObject(raw, "session");

  const version = raw.version;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new SessionParseError(
      `Unsupported session version: ${String(version)}. Supported versions: 1, 2, 3.`,
    );
  }

  assertString(raw.savedAt, "savedAt");
  validateMetadata(raw.metadata);

  assertObject(raw.context, "context");
  const ctx = raw.context as Record<string, unknown>;

  assertArray(ctx.preamble, "context.preamble");
  for (let i = 0; i < (ctx.preamble as unknown[]).length; i++) {
    validateMessage((ctx.preamble as unknown[])[i], `context.preamble[${i}]`);
  }

  assertArray(ctx.turns, "context.turns");
  for (let i = 0; i < (ctx.turns as unknown[]).length; i++) {
    validateTurn((ctx.turns as unknown[])[i], `context.turns[${i}]`);
  }

  assertArray(ctx.artifacts, "context.artifacts");
  for (let i = 0; i < (ctx.artifacts as unknown[]).length; i++) {
    validateArtifact(
      (ctx.artifacts as unknown[])[i],
      `context.artifacts[${i}]`,
    );
  }

  if (ctx.rollingSummary !== undefined) {
    validateRollingSummary(ctx.rollingSummary, "context.rollingSummary");
  }

  if (version === 2 || version === 3) {
    assertArray(ctx.pinnedMemory, "context.pinnedMemory");
    for (let i = 0; i < (ctx.pinnedMemory as unknown[]).length; i++) {
      validatePinnedMemoryRecord(
        (ctx.pinnedMemory as unknown[])[i],
        `context.pinnedMemory[${i}]`,
      );
    }
  }

  if (version === 3) {
    assertArray(ctx.invokedSkills, "context.invokedSkills");
    for (let i = 0; i < (ctx.invokedSkills as unknown[]).length; i++) {
      validateInvokedSkillRecord(
        (ctx.invokedSkills as unknown[])[i],
        `context.invokedSkills[${i}]`,
      );
    }
    return raw as unknown as PersistedSessionV3;
  }

  if (version === 2) {
    return raw as unknown as PersistedSessionV2;
  }

  return raw as unknown as PersistedSessionV1;
}

// ---------------------------------------------------------------------------
// Restoration (PersistedSessionV1 → runtime ConversationState)
// ---------------------------------------------------------------------------

function restoreImage(img: PersistedImage): Uint8Array | string {
  if (img.encoding === "base64") {
    return new Uint8Array(Buffer.from(img.data, "base64"));
  }
  return img.data;
}

function restoreMessage(msg: PersistedChatMessage): ChatMessage {
  const result: ChatMessage = { role: msg.role, content: msg.content };
  if (msg.reasoningContent !== undefined) {
    result.reasoningContent = msg.reasoningContent;
  }
  if (msg.toolCalls) {
    result.toolCalls = msg.toolCalls.map((tc) => ({
      ...tc,
      function: {
        ...tc.function,
        arguments: structuredClone(tc.function.arguments),
      },
    }));
  }
  if (msg.toolCallId !== undefined) result.toolCallId = msg.toolCallId;
  if (msg.toolResults) {
    result.toolResults = msg.toolResults.map((tr) => ({ ...tr }));
  }
  if (msg.images) result.images = msg.images.map(restoreImage);
  return result;
}

function restoreEntry(entry: PersistedTurnEntry): TurnEntry {
  const base = {
    kind: entry.kind,
    createdAt: entry.createdAt,
    estimatedTokens: entry.estimatedTokens,
    message: restoreMessage(entry.message),
  };

  if (entry.kind === "tool" && entry.toolInvocations) {
    return {
      ...base,
      kind: "tool" as const,
      toolInvocations: entry.toolInvocations.map((inv) => ({ ...inv })),
    };
  }

  return base as TurnEntry;
}

function restoreTurn(turn: PersistedTurnRecord): TurnRecord {
  return {
    id: turn.id,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    importance: turn.importance,
    summary: turn.summary,
    estimatedTokens: turn.estimatedTokens,
    userMessage: restoreMessage(turn.userMessage),
    entries: turn.entries.map(restoreEntry),
  };
}

function restoreArtifact(artifact: PersistedArtifactRecord): ArtifactRecord {
  const content =
    artifact.contentEncoding === "base64"
      ? new Uint8Array(Buffer.from(artifact.content, "base64"))
      : artifact.content;

  return {
    id: artifact.id,
    type: artifact.type,
    mediaType: artifact.mediaType,
    createdAt: artifact.createdAt,
    content,
    contentSizeChars: artifact.contentSizeChars,
    estimatedTokens: artifact.estimatedTokens,
    referencingTurnIds: [...artifact.referencingTurnIds],
  };
}

function restorePinnedMemory(
  record: PersistedPinnedMemoryRecord,
): PinnedMemoryRecord {
  return {
    id: record.id,
    kind: record.kind,
    scope: record.scope,
    content: record.content,
    source: { ...record.source },
    rationale: record.rationale,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lifecycle: record.lifecycle,
    supersededById: record.supersededById,
  };
}

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
  persisted: PersistedSessionV1 | PersistedSessionV2 | PersistedSessionV3,
): ConversationState {
  const pinnedMemory =
    persisted.version === 2 || persisted.version === 3
      ? (persisted as PersistedSessionV2).context.pinnedMemory.map(
          restorePinnedMemory,
        )
      : [];
  const invokedSkills =
    persisted.version === 3
      ? (persisted as PersistedSessionV3).context.invokedSkills.map(
          restoreInvokedSkill,
        )
      : [];

  return {
    preamble: persisted.context.preamble.map(restoreMessage),
    turns: persisted.context.turns.map(restoreTurn),
    artifacts: persisted.context.artifacts.map(restoreArtifact),
    rollingSummary: persisted.context.rollingSummary
      ? {
          ...persisted.context.rollingSummary,
          coveredTurnIds: [...persisted.context.rollingSummary.coveredTurnIds],
        }
      : undefined,
    pinnedMemory,
    invokedSkills,
  };
}
