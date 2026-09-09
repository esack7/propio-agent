import { Buffer } from "buffer";
import type {
  ChatMessage,
  ChatToolCall,
  ToolResult,
} from "@propio-ai/providers";
import type {
  ConversationState,
  TurnRecord,
  TurnEntry,
  ArtifactRecord,
  ToolInvocationRecord,
  RollingSummaryRecord,
  PinnedMemoryRecord,
  MemoryKind,
  MemoryScope,
  MemoryLifecycle,
  MemoryOrigin,
} from "./coreTypes.js";

export class SessionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionParseError";
  }
}

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
  readonly externalPath?: string;
  readonly externalSizeBytes?: number;
  readonly externalLineCount?: number;
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
  const persisted: PersistedArtifactRecord = {
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
  if (artifact.externalPath) {
    (persisted as any).externalPath = artifact.externalPath;
  }
  if (artifact.externalSizeBytes !== undefined) {
    (persisted as any).externalSizeBytes = artifact.externalSizeBytes;
  }
  if (artifact.externalLineCount !== undefined) {
    (persisted as any).externalLineCount = artifact.externalLineCount;
  }
  return persisted;
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

export function assertObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionParseError(`${label} must be a non-null object`);
  }
}

export function assertArray(
  value: unknown,
  label: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new SessionParseError(`${label} must be an array`);
  }
}

export function assertString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new SessionParseError(`${label} must be a string`);
  }
}

export function assertNumber(
  value: unknown,
  label: string,
): asserts value is number {
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
const VALID_SECTION_KEYS = new Set<string>([
  "narrative",
  "goals",
  "constraints",
  "decisions",
  "facts",
  "accomplished",
  "remaining",
]);
export function validateOptionalStringFields(
  obj: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  for (const field of fields) {
    if (obj[field] !== undefined) {
      assertString(obj[field], `${label}.${field}`);
    }
  }
}

export function validateStringArrayField(
  obj: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (obj[field] === undefined) {
    return;
  }
  assertArray(obj[field], `${label}.${field}`);
  const items = obj[field] as unknown[];
  for (let i = 0; i < items.length; i++) {
    assertString(items[i], `${label}.${field}[${i}]`);
  }
}

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

function validateMessageImage(img: unknown, label: string): void {
  assertObject(img, label);
  const imgObj = img as Record<string, unknown>;
  assertString(imgObj.data, `${label}.data`);
  assertString(imgObj.encoding, `${label}.encoding`);
  if (!VALID_CONTENT_ENCODING.has(imgObj.encoding as string)) {
    throw new SessionParseError(`${label}.encoding must be "utf8" or "base64"`);
  }
  if (imgObj.encoding === "base64") {
    validateBase64(imgObj.data as string, label);
  }
}

function validateMessageToolCalls(
  msg: Record<string, unknown>,
  label: string,
): void {
  if (msg.toolCalls === undefined) {
    return;
  }
  assertArray(msg.toolCalls, `${label}.toolCalls`);
  const toolCalls = msg.toolCalls as unknown[];
  for (let i = 0; i < toolCalls.length; i++) {
    validateToolCall(toolCalls[i], `${label}.toolCalls[${i}]`);
  }
}

function validateMessageToolResults(
  msg: Record<string, unknown>,
  label: string,
): void {
  if (msg.toolResults === undefined) {
    return;
  }
  assertArray(msg.toolResults, `${label}.toolResults`);
  const toolResults = msg.toolResults as unknown[];
  for (let i = 0; i < toolResults.length; i++) {
    validateToolResult(toolResults[i], `${label}.toolResults[${i}]`);
  }
}

function validateMessageImages(
  msg: Record<string, unknown>,
  label: string,
): void {
  if (msg.images === undefined) {
    return;
  }
  assertArray(msg.images, `${label}.images`);
  const images = msg.images as unknown[];
  for (let i = 0; i < images.length; i++) {
    validateMessageImage(images[i], `${label}.images[${i}]`);
  }
}

function validateMessage(msg: unknown, label: string): void {
  assertObject(msg, label);
  const record = msg as Record<string, unknown>;
  assertString(record.role, `${label}.role`);
  if (!VALID_ROLES.has(record.role as string)) {
    throw new SessionParseError(
      `${label}.role must be one of: user, assistant, system, tool`,
    );
  }
  assertString(record.content, `${label}.content`);
  if (record.reasoningContent !== undefined) {
    assertString(record.reasoningContent, `${label}.reasoningContent`);
  }
  validateMessageToolCalls(record, label);
  validateMessageToolResults(record, label);
  validateMessageImages(record, label);
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
  // Optional structured sections (Phase 5)
  const s = summary as Record<string, unknown>;
  if (s.sections !== undefined) {
    assertObject(s.sections, `${label}.sections`);
    const sections = s.sections as Record<string, unknown>;
    for (const [k, v] of Object.entries(sections)) {
      if (!VALID_SECTION_KEYS.has(k)) {
        throw new SessionParseError(
          `${label}.sections contains unknown key "${k}"`,
        );
      }
      assertString(v, `${label}.sections.${k}`);
    }
  }
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

  const restored: ArtifactRecord = {
    id: artifact.id,
    type: artifact.type,
    mediaType: artifact.mediaType,
    createdAt: artifact.createdAt,
    content,
    contentSizeChars: artifact.contentSizeChars,
    estimatedTokens: artifact.estimatedTokens,
    referencingTurnIds: [...artifact.referencingTurnIds],
  };

  if ((artifact as any).externalPath) {
    (restored as any).externalPath = (artifact as any).externalPath;
  }
  if ((artifact as any).externalSizeBytes !== undefined) {
    (restored as any).externalSizeBytes = (artifact as any).externalSizeBytes;
  }
  if ((artifact as any).externalLineCount !== undefined) {
    (restored as any).externalLineCount = (artifact as any).externalLineCount;
  }

  return restored;
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

/** Version of the reusable context document, independent of CLI session versions. */
interface PersistedContext {
  readonly version: 1;
  readonly context: EncodedConversationState;
}

export interface EncodedConversationState {
  readonly preamble: ReadonlyArray<PersistedChatMessage>;
  readonly turns: ReadonlyArray<PersistedTurnRecord>;
  readonly artifacts: ReadonlyArray<PersistedArtifactRecord>;
  readonly pinnedMemory?: ReadonlyArray<PersistedPinnedMemoryRecord>;
  readonly rollingSummary?: RollingSummaryRecord;
}

export function encodeConversationState(
  state: ConversationState,
): EncodedConversationState & {
  readonly pinnedMemory: ReadonlyArray<PersistedPinnedMemoryRecord>;
} {
  return {
    preamble: state.preamble.map(persistMessage),
    turns: state.turns.map(persistTurn),
    artifacts: state.artifacts.map(persistArtifact),
    pinnedMemory: (state.pinnedMemory ?? []).map(persistPinnedMemory),
    ...(state.rollingSummary
      ? { rollingSummary: structuredClone(state.rollingSummary) }
      : {}),
  };
}

export function decodeConversationState(
  context: EncodedConversationState,
): ConversationState {
  return {
    preamble: context.preamble.map(restoreMessage),
    turns: context.turns.map(restoreTurn),
    artifacts: context.artifacts.map(restoreArtifact),
    pinnedMemory: (context.pinnedMemory ?? []).map(restorePinnedMemory),
    rollingSummary: context.rollingSummary
      ? structuredClone(context.rollingSummary)
      : undefined,
  };
}

function validateRecords(
  value: unknown,
  label: string,
  validate: (value: unknown, label: string) => void,
): void {
  assertArray(value, label);
  value.forEach((record, index) => validate(record, `${label}[${index}]`));
}

export function validateConversationState(
  value: unknown,
  requireMemory = true,
): asserts value is EncodedConversationState {
  assertObject(value, "context");
  validateRecords(value.preamble, "context.preamble", validateMessage);
  validateRecords(value.turns, "context.turns", validateTurn);
  validateRecords(value.artifacts, "context.artifacts", validateArtifact);
  if (value.rollingSummary !== undefined)
    validateRollingSummary(value.rollingSummary, "context.rollingSummary");
  if (requireMemory)
    validateRecords(
      value.pinnedMemory,
      "context.pinnedMemory",
      validatePinnedMemoryRecord,
    );
}

export function serializeContext(state: ConversationState): string {
  const document: PersistedContext = {
    version: 1,
    context: encodeConversationState(state),
  };
  return JSON.stringify(document, null, 2);
}

export function parseContext(json: string): ConversationState {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    throw new SessionParseError("Invalid JSON: could not parse context data");
  }
  assertObject(document, "context document");
  if (document.version !== 1)
    throw new SessionParseError(
      `Unsupported context version: ${String(document.version)}`,
    );
  validateConversationState(document.context);
  return decodeConversationState(document.context);
}
