import { ChatMessage } from "@propio-ai/providers";

export const RESERVED_OUTPUT_TOKENS = 2048;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function messageChars(msg: Readonly<ChatMessage>): number {
  let chars = msg.content.length;
  if (msg.reasoningContent) {
    chars += msg.reasoningContent.length;
  }
  if (msg.toolCalls) {
    chars += JSON.stringify(msg.toolCalls).length;
  }
  if (msg.toolResults) {
    chars += JSON.stringify(msg.toolResults).length;
  }
  if (msg.images) {
    for (const image of msg.images) {
      if (image instanceof Uint8Array) {
        chars += image.byteLength;
      } else if (image.startsWith("data:")) {
        const comma = image.indexOf(",");
        chars += comma >= 0 ? image.length - comma - 1 : image.length;
      } else {
        chars += image.length;
      }
    }
  }
  return chars;
}

export function measureMessages(
  messages: ReadonlyArray<Readonly<ChatMessage>>,
): {
  messageCount: number;
  totalChars: number;
  estimatedTokens: number;
} {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += messageChars(msg);
  }
  return {
    messageCount: messages.length,
    totalChars,
    estimatedTokens: estimateTokens(totalChars),
  };
}

/** Estimates are advisory. The fallback uses ceil(characters / 4), counts image
 * bytes/data-URL characters, and cannot model image tokens or provider overhead. */
export interface TokenEstimator {
  estimateText(text: string): number;
  estimateMessages(messages: ReadonlyArray<Readonly<ChatMessage>>): number;
  estimateCharacters(chars: number): number;
}

export const characterTokenEstimator: TokenEstimator = {
  estimateText: (text) => estimateTokens(text.length),
  estimateMessages: (messages) => measureMessages(messages).estimatedTokens,
  estimateCharacters: estimateTokens,
};
