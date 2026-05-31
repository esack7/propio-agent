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

type ParserState = {
  prefixHold: string;
  insidePaste: boolean;
  pasteBody: string;
};

type ParseStepResult =
  | { done: true; events: ParsedKeypress[] }
  | { done: false; index: number };

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
  "\x1b[Z": "backtab",
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

function flushPaste(events: ParsedKeypress[], state: ParserState): void {
  events.push({ kind: "paste", text: state.pasteBody, isPasted: true });
  state.pasteBody = "";
  state.insidePaste = false;
}

function isLargeUnbracketedPaste(input: string): boolean {
  return input.length > PASTE_THRESHOLD && !input.includes(PASTE_START);
}

function isSimpleKeyInput(input: string): boolean {
  return (
    !input.includes(PASTE_START) &&
    !input.includes("\x1b") &&
    input.length <= PASTE_THRESHOLD
  );
}

function isNamedKeyInput(
  input: string,
  key: readline.Key,
  holdableStart: string,
): boolean {
  return (
    key.sequence === input &&
    Boolean(key.name) &&
    key.name !== "" &&
    !input.includes(PASTE_START) &&
    holdableStart === ""
  );
}

function getImmediateNonPasteEvents(
  input: string,
  str: string | undefined,
  key: readline.Key,
  state: ParserState,
): ParsedKeypress[] | null {
  if (input.length === 0) {
    return [{ kind: "key", str, key }];
  }

  if (isLargeUnbracketedPaste(input)) {
    return [{ kind: "paste", text: input, isPasted: true }];
  }

  if (key.name === "escape" && input === "\x1b") {
    return [{ kind: "key", str, key }];
  }

  const holdableStart = getHoldablePastePrefix(input, PASTE_START);
  if (holdableStart === input) {
    state.prefixHold = input;
    return [];
  }

  if (isSimpleKeyInput(input)) {
    return [{ kind: "key", str, key }];
  }

  if (isNamedKeyInput(input, key, holdableStart)) {
    return [{ kind: "key", str, key }];
  }

  return null;
}

function processInsidePaste(
  events: ParsedKeypress[],
  input: string,
  index: number,
  state: ParserState,
): ParseStepResult {
  const endAt = input.indexOf(PASTE_END, index);
  if (endAt !== -1) {
    state.pasteBody += input.slice(index, endAt);
    flushPaste(events, state);
    return { done: false, index: endAt + PASTE_END.length };
  }

  const remaining = input.slice(index);
  const holdLen = longestPasteEndSuffixPrefix(remaining);
  if (holdLen > 0) {
    state.pasteBody += remaining.slice(0, -holdLen);
    state.prefixHold = remaining.slice(-holdLen);
    return { done: true, events };
  }

  state.pasteBody += remaining;
  return { done: true, events };
}

function processTailWithoutPasteStart(
  events: ParsedKeypress[],
  tail: string,
  key: readline.Key,
  state: ParserState,
): ParsedKeypress[] {
  const holdable = getHoldablePastePrefix(tail, PASTE_START);
  if (holdable === tail) {
    state.prefixHold = holdable;
    return events;
  }

  const holdLen = longestPasteStartSuffixPrefix(tail);
  if (holdLen > 0) {
    appendNonPasteTail(events, tail.slice(0, -holdLen), key);
    state.prefixHold = tail.slice(-holdLen);
    return events;
  }

  appendNonPasteTail(events, tail, key);
  return events;
}

function processOutsidePaste(
  events: ParsedKeypress[],
  input: string,
  index: number,
  key: readline.Key,
  state: ParserState,
): ParseStepResult {
  const startAt = input.indexOf(PASTE_START, index);
  if (startAt === -1) {
    return {
      done: true,
      events: processTailWithoutPasteStart(
        events,
        input.slice(index),
        key,
        state,
      ),
    };
  }

  if (startAt > index) {
    appendNonPasteTail(events, input.slice(index, startAt), key);
    return { done: false, index: startAt };
  }

  state.insidePaste = true;
  return { done: false, index: index + PASTE_START.length };
}

export function createKeypressParser(): KeypressParser {
  const state: ParserState = {
    prefixHold: "",
    insidePaste: false,
    pasteBody: "",
  };

  const parse = (
    str: string | undefined,
    key: readline.Key,
  ): ParsedKeypress[] => {
    const events: ParsedKeypress[] = [];
    const chunk = getInputChunk(str, key);
    const input = state.prefixHold + chunk;
    state.prefixHold = "";

    if (!state.insidePaste) {
      const immediateEvents = getImmediateNonPasteEvents(
        input,
        str,
        key,
        state,
      );
      if (immediateEvents) {
        return immediateEvents;
      }
    }

    let index = 0;
    while (index < input.length) {
      const result = state.insidePaste
        ? processInsidePaste(events, input, index, state)
        : processOutsidePaste(events, input, index, key, state);
      if (result.done) {
        return result.events;
      }
      index = result.index;
    }

    if (state.insidePaste) {
      return events;
    }

    return events.length > 0 ? events : [{ kind: "key", str, key }];
  };

  return { parse };
}
