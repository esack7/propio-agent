import * as path from "path";
import type { InputMode } from "../inputModes.js";
import type { PastedContent } from "./pastedContent.js";
import type { PromptImage, PromptSubmission } from "./promptSubmission.js";

const TEXT_PILL_PATTERN = /\[(?:Pasted text) #(\d+)(?: \+(\d+) lines)?\]/g;
const IMAGE_PILL_PATTERN = /\[Image #(\d+)\]/g;

interface TokenMatch {
  index: number;
  length: number;
  id: number;
  kind: "text" | "image";
}

function pushPatternMatches(
  displayText: string,
  pattern: RegExp,
  kind: TokenMatch["kind"],
  matches: TokenMatch[],
): void {
  for (const match of displayText.matchAll(pattern)) {
    const id = Number(match[1]);
    if (!Number.isFinite(id)) {
      continue;
    }
    matches.push({
      index: match.index ?? 0,
      length: match[0].length,
      id,
      kind,
    });
  }
}

function collectTokenMatches(displayText: string): TokenMatch[] {
  const matches: TokenMatch[] = [];
  pushPatternMatches(displayText, TEXT_PILL_PATTERN, "text", matches);
  pushPatternMatches(displayText, IMAGE_PILL_PATTERN, "image", matches);
  matches.sort((left, right) => left.index - right.index);
  return matches;
}

function expandImageEntry(entry: Extract<PastedContent, { type: "image" }>): {
  text: string;
  image: PromptImage;
} {
  const basename = path.basename(entry.filename || entry.path || "image");
  return {
    text: `[Attached image: ${basename}]`,
    image: entry.data,
  };
}

export function expandPastedRefs(
  displayText: string,
  pastedContents: ReadonlyMap<number, PastedContent>,
  inputMode: InputMode,
): PromptSubmission {
  const tokens = collectTokenMatches(displayText);
  if (tokens.length === 0) {
    return {
      text: displayText,
      displayText,
      inputMode,
    };
  }

  const textParts: string[] = [];
  const images: PromptImage[] = [];
  let cursor = 0;

  for (const token of tokens) {
    textParts.push(displayText.slice(cursor, token.index));
    const entry = pastedContents.get(token.id);

    if (!entry || entry.type !== token.kind) {
      textParts.push(
        displayText.slice(token.index, token.index + token.length),
      );
      cursor = token.index + token.length;
      continue;
    }

    if (entry.type === "text") {
      textParts.push(entry.content);
    } else {
      const expanded = expandImageEntry(entry);
      textParts.push(expanded.text);
      images.push(expanded.image);
    }

    cursor = token.index + token.length;
  }

  textParts.push(displayText.slice(cursor));

  return {
    text: textParts.join(""),
    displayText,
    inputMode,
    images: images.length > 0 ? images : undefined,
  };
}
