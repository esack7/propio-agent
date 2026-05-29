import type { ChatMessage, ChatToolCall } from "../providers/types.js";

const MENTION_TOOL_CALL_ID_PATTERN = /^mention_\d+$/;
const MENTION_TOOL_NAMES = new Set(["read", "ls"]);

function isMentionToolCallId(id: string | undefined): boolean {
  return id != null && MENTION_TOOL_CALL_ID_PATTERN.test(id);
}

function isSyntheticMentionToolCall(toolCall: ChatToolCall): boolean {
  const name = toolCall.function.name;
  return (
    isMentionToolCallId(toolCall.id) &&
    MENTION_TOOL_NAMES.has(name) &&
    toolCall.thoughtSignature == null
  );
}

export function isSyntheticMentionAssistantMessage(
  message: ChatMessage,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if ((message.content ?? "").trim().length > 0) {
    return false;
  }
  const toolCalls = message.toolCalls;
  if (!toolCalls || toolCalls.length === 0) {
    return false;
  }
  return toolCalls.every(isSyntheticMentionToolCall);
}

export function isSyntheticMentionToolMessage(
  message: ChatMessage,
  expectedToolCallIds: ReadonlySet<string>,
): boolean {
  if (message.role !== "tool" || !message.toolResults?.length) {
    return false;
  }
  const resultIds = new Set(
    message.toolResults.map((result) => result.toolCallId),
  );
  if (resultIds.size !== expectedToolCallIds.size) {
    return false;
  }
  for (const id of expectedToolCallIds) {
    if (!resultIds.has(id)) {
      return false;
    }
  }
  return message.toolResults.every((result) =>
    MENTION_TOOL_NAMES.has(result.toolName),
  );
}

export function collectMentionToolCallIds(message: ChatMessage): Set<string> {
  return new Set(
    (message.toolCalls ?? [])
      .map((toolCall) => toolCall.id)
      .filter((id): id is string => id != null),
  );
}

export function isSyntheticMentionMessagePair(
  assistantMessage: ChatMessage,
  toolMessage: ChatMessage | undefined,
): boolean {
  if (!isSyntheticMentionAssistantMessage(assistantMessage)) {
    return false;
  }
  if (!toolMessage) {
    return false;
  }
  return isSyntheticMentionToolMessage(
    toolMessage,
    collectMentionToolCallIds(assistantMessage),
  );
}

export function formatSyntheticMentionInlineContext(
  assistantMessage: ChatMessage,
  toolMessage: ChatMessage,
): string {
  const sections: string[] = [
    "The user attached the following files via @ mentions:",
  ];

  const resultsById = new Map(
    (toolMessage.toolResults ?? []).map((result) => [
      result.toolCallId,
      result,
    ]),
  );

  for (const toolCall of assistantMessage.toolCalls ?? []) {
    const id = toolCall.id ?? "unknown";
    const args = toolCall.function.arguments;
    const originalPath = typeof args.path === "string" ? args.path : undefined;
    const resolvedPath =
      typeof args.resolvedPath === "string" ? args.resolvedPath : undefined;
    const result = resultsById.get(id);

    const headerParts = [
      `[attachment tool="${toolCall.function.name}" mention_id="${id}"`,
    ];
    if (originalPath) {
      headerParts.push(` path="${originalPath}"`);
    }
    if (resolvedPath) {
      headerParts.push(` resolved_path="${resolvedPath}"`);
    }
    headerParts.push("]");

    sections.push(headerParts.join(""));
    sections.push(result?.content ?? "");
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}
