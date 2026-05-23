import type * as readline from "readline";
import { PASTE_THRESHOLD } from "./constants.js";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

export type ParsedKeypress =
  | { kind: "paste"; text: string; isPasted: true }
  | { kind: "key"; str: string | undefined; key: readline.Key };

export type KeypressParser = {
  parse(str: string | undefined, key: readline.Key): ParsedKeypress[];
};

function getInputChunk(str: string | undefined, key: readline.Key): string {
  if (str !== undefined && str !== "") {
    return str;
  }
  return key.sequence ?? "";
}

function isStrictPasteMarkerPrefix(marker: string, partial: string): boolean {
  return (
    partial.length > 0 &&
    marker.startsWith(partial) &&
    partial.length < marker.length
  );
}

function getHoldablePastePrefix(input: string, marker: string): string {
  return isStrictPasteMarkerPrefix(marker, input) ? input : "";
}

function longestPasteEndSuffixPrefix(input: string): number {
  const maxLen = Math.min(input.length, PASTE_END.length - 1);
  for (let len = maxLen; len >= 1; len--) {
    const suffix = input.slice(-len);
    if (isStrictPasteMarkerPrefix(PASTE_END, suffix)) {
      return len;
    }
  }
  return 0;
}

function longestPasteStartSuffixPrefix(input: string): number {
  const maxLen = Math.min(input.length, PASTE_START.length - 1);
  for (let len = maxLen; len >= 1; len--) {
    const suffix = input.slice(-len);
    if (isStrictPasteMarkerPrefix(PASTE_START, suffix)) {
      return len;
    }
  }
  return 0;
}

function findCsiEnd(input: string, start: number): number {
  if (input[start] !== "\x1b") {
    return start + 1;
  }
  if (start + 1 >= input.length) {
    return start + 1;
  }
  if (input[start + 1] !== "[") {
    return Math.min(start + 2, input.length);
  }

  for (let i = start + 2; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) {
      return i + 1;
    }
  }

  return input.length;
}

function synthesizeTrailingPrintable(
  text: string,
  base: readline.Key,
): readline.Key {
  return {
    ...base,
    sequence: text,
    name: text,
    ctrl: false,
    meta: false,
  };
}

const SPECIAL_KEY_NAMES_BY_SEQUENCE: Record<string, string> = {
  "\x1b": "escape",
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1b[F": "end",
  "\x1b[H": "home",
  "\x1b[1~": "home",
  "\x1b[3~": "delete",
  "\x1b[4~": "end",
  "\x1b[5~": "pageup",
  "\x1b[6~": "pagedown",
};

function synthesizeSpecialKey(
  sequence: string,
  base: readline.Key,
): readline.Key {
  return {
    ...base,
    sequence,
    name: SPECIAL_KEY_NAMES_BY_SEQUENCE[sequence],
    ctrl: base.ctrl ?? false,
    meta: base.meta ?? false,
    shift: base.shift ?? false,
  };
}

function appendNonPasteTail(
  events: ParsedKeypress[],
  tail: string,
  key: readline.Key,
): void {
  if (tail.length === 0) {
    return;
  }

  if (tail.length > PASTE_THRESHOLD) {
    events.push({ kind: "paste", text: tail, isPasted: true });
    return;
  }

  const appendTextSegment = (text: string): void => {
    if (text.length === 1) {
      events.push({
        kind: "key",
        str: text,
        key: synthesizeTrailingPrintable(text, key),
      });
    } else {
      events.push({ kind: "key", str: text, key });
    }
  };

  let remaining = tail;
  while (remaining.length > 0) {
    const escapeAt = remaining.indexOf("\x1b");
    if (escapeAt === -1) {
      appendTextSegment(remaining);
      return;
    }

    if (escapeAt > 0) {
      appendTextSegment(remaining.slice(0, escapeAt));
      remaining = remaining.slice(escapeAt);
      continue;
    }

    const seqEnd = findCsiEnd(remaining, 0);
    const sequence = remaining.slice(0, seqEnd);
    events.push({
      kind: "key",
      str: undefined,
      key: synthesizeSpecialKey(sequence, key),
    });
    remaining = remaining.slice(seqEnd);
  }
}

export function createKeypressParser(): KeypressParser {
  let prefixHold = "";
  let insidePaste = false;
  let pasteBody = "";

  const flushPaste = (events: ParsedKeypress[]): void => {
    events.push({ kind: "paste", text: pasteBody, isPasted: true });
    pasteBody = "";
    insidePaste = false;
  };

  const parse = (
    str: string | undefined,
    key: readline.Key,
  ): ParsedKeypress[] => {
    const events: ParsedKeypress[] = [];
    const chunk = getInputChunk(str, key);
    let input = prefixHold + chunk;
    prefixHold = "";

    if (!insidePaste && input.length === 0) {
      return [{ kind: "key", str, key }];
    }

    if (!insidePaste && input.length > 0) {
      if (input.length > PASTE_THRESHOLD && !input.includes(PASTE_START)) {
        return [{ kind: "paste", text: input, isPasted: true }];
      }

      if (key.name === "escape" && input === "\x1b") {
        return [{ kind: "key", str, key }];
      }

      const holdableStart = getHoldablePastePrefix(input, PASTE_START);
      if (holdableStart === input) {
        prefixHold = input;
        return [];
      }

      if (
        !input.includes(PASTE_START) &&
        !input.includes("\x1b") &&
        input.length <= PASTE_THRESHOLD
      ) {
        return [{ kind: "key", str, key }];
      }

      if (
        key.sequence === input &&
        key.name &&
        key.name !== "" &&
        !input.includes(PASTE_START) &&
        getHoldablePastePrefix(input, PASTE_START) === ""
      ) {
        return [{ kind: "key", str, key }];
      }
    }

    let index = 0;
    while (index < input.length) {
      if (insidePaste) {
        const endAt = input.indexOf(PASTE_END, index);
        if (endAt !== -1) {
          pasteBody += input.slice(index, endAt);
          flushPaste(events);
          index = endAt + PASTE_END.length;
          continue;
        }

        const remaining = input.slice(index);
        const holdLen = longestPasteEndSuffixPrefix(remaining);
        if (holdLen > 0 && holdLen === remaining.length) {
          prefixHold = remaining;
          return events;
        }
        if (holdLen > 0) {
          pasteBody += remaining.slice(0, -holdLen);
          prefixHold = remaining.slice(-holdLen);
          return events;
        }

        pasteBody += remaining;
        return events;
      }

      const startAt = input.indexOf(PASTE_START, index);
      if (startAt === -1) {
        const tail = input.slice(index);
        const holdable = getHoldablePastePrefix(tail, PASTE_START);
        if (holdable === tail) {
          prefixHold = holdable;
          return events;
        }

        const holdLen = longestPasteStartSuffixPrefix(tail);
        if (holdLen > 0) {
          appendNonPasteTail(events, tail.slice(0, -holdLen), key);
          prefixHold = tail.slice(-holdLen);
          return events;
        }

        appendNonPasteTail(events, tail, key);
        return events;
      }

      if (startAt > index) {
        const before = input.slice(index, startAt);
        appendNonPasteTail(events, before, key);
        index = startAt;
        continue;
      }

      index += PASTE_START.length;
      insidePaste = true;
      continue;
    }

    if (insidePaste) {
      return events;
    }

    return events.length > 0 ? events : [{ kind: "key", str, key }];
  };

  return { parse };
}
