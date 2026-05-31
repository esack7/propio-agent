import type * as readline from "readline";
import {
  createKeypressParser,
  PASTE_END,
  PASTE_START,
} from "../parseKeypress.js";
import { PASTE_THRESHOLD } from "../constants.js";

function baseKey(overrides: Partial<readline.Key> = {}): readline.Key {
  return {
    sequence: "",
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    ...overrides,
  };
}

function parse(
  parser: ReturnType<typeof createKeypressParser>,
  str: string | undefined,
  key: readline.Key,
) {
  return parser.parse(str, key);
}

function parseSequence(sequence: string) {
  return parse(createKeypressParser(), undefined, baseKey({ sequence }));
}

function expectPasteWithTrailingKey(
  trailing: string,
  expectedKey: readline.Key,
): void {
  expect(parseSequence(`${PASTE_START}hello${PASTE_END}${trailing}`)).toEqual([
    { kind: "paste", text: "hello", isPasted: true },
    {
      kind: "key",
      str: expectedKey.name === trailing ? trailing : undefined,
      key: expectedKey,
    },
  ]);
}

describe("createKeypressParser", () => {
  it("parses a full bracketed paste as one paste event", () => {
    expect(parseSequence(`${PASTE_START}hello${PASTE_END}`)).toEqual([
      { kind: "paste", text: "hello", isPasted: true },
    ]);
  });

  it("parses bracketed paste split across multiple parse calls", () => {
    const parser = createKeypressParser();

    expect(
      parse(parser, undefined, baseKey({ sequence: PASTE_START.slice(0, 3) })),
    ).toEqual([]);
    expect(
      parse(parser, undefined, baseKey({ sequence: PASTE_START.slice(3) })),
    ).toEqual([]);
    expect(parse(parser, undefined, baseKey({ sequence: "hello" }))).toEqual(
      [],
    );
    expect(
      parse(parser, undefined, baseKey({ sequence: PASTE_END.slice(0, 4) })),
    ).toEqual([]);
    expect(
      parse(parser, undefined, baseKey({ sequence: PASTE_END.slice(4) })),
    ).toEqual([{ kind: "paste", text: "hello", isPasted: true }]);
  });

  it("emits an empty paste when the body is empty", () => {
    const parser = createKeypressParser();
    const events = parse(
      parser,
      undefined,
      baseKey({ sequence: `${PASTE_START}${PASTE_END}` }),
    );

    expect(events).toEqual([{ kind: "paste", text: "", isPasted: true }]);
  });

  it("holds a bracketed prefix then completes the paste", () => {
    const parser = createKeypressParser();

    expect(parse(parser, "\x1b", baseKey({ sequence: "\x1b" }))).toEqual([]);
    expect(parse(parser, undefined, baseKey({ sequence: "[200~hi" }))).toEqual(
      [],
    );
    expect(
      parse(parser, undefined, baseKey({ sequence: `${PASTE_END}` })),
    ).toEqual([{ kind: "paste", text: "hi", isPasted: true }]);
  });

  it("emits paste and a synthesized trailing key in one sequence", () => {
    expectPasteWithTrailingKey("x", {
      sequence: "x",
      name: "x",
      ctrl: false,
      meta: false,
      shift: false,
    });
  });

  it("emits paste and a synthesized trailing navigation key in one sequence", () => {
    expectPasteWithTrailingKey("\x1b[A", {
      sequence: "\x1b[A",
      name: "up",
      ctrl: false,
      meta: false,
      shift: false,
    });
  });

  it("holds a bracketed paste prefix suffix after preceding text", () => {
    const parser = createKeypressParser();
    const key = baseKey({ sequence: `abc${PASTE_START.slice(0, -1)}` });

    expect(parse(parser, undefined, key)).toEqual([
      { kind: "key", str: "abc", key },
    ]);
    expect(
      parse(parser, undefined, baseKey({ sequence: `~hello${PASTE_END}` })),
    ).toEqual([{ kind: "paste", text: "hello", isPasted: true }]);
  });

  it("passes lone Escape through without delay", () => {
    const parser = createKeypressParser();
    const key = baseKey({ sequence: "\x1b", name: "escape" });
    const events = parse(parser, undefined, key);

    expect(events).toEqual([{ kind: "key", str: undefined, key }]);
  });

  it("parses Shift+Tab backtab escape sequence", () => {
    expect(parseSequence("\x1b[Z")).toEqual([
      {
        kind: "key",
        str: undefined,
        key: {
          sequence: "\x1b[Z",
          name: "backtab",
          ctrl: false,
          meta: false,
          shift: false,
        },
      },
    ]);
  });

  it("passes arrow keys through without delay", () => {
    const parser = createKeypressParser();
    const key = baseKey({ sequence: "\x1b[A", name: "up" });
    const events = parse(parser, undefined, key);

    expect(events).toEqual([{ kind: "key", str: undefined, key }]);
  });

  it("treats printable input over the threshold as paste", () => {
    const parser = createKeypressParser();
    const text = "a".repeat(PASTE_THRESHOLD + 1);
    const events = parse(parser, text, baseKey({ sequence: text, name: "" }));

    expect(events).toEqual([{ kind: "paste", text, isPasted: true }]);
  });

  it("treats a normal single character as a key event", () => {
    const parser = createKeypressParser();
    const key = baseKey({ sequence: "x", name: "x" });
    const events = parse(parser, "x", key);

    expect(events).toEqual([
      {
        kind: "key",
        str: "x",
        key: {
          ...key,
          sequence: "x",
          name: "x",
          ctrl: false,
          meta: false,
        },
      },
    ]);
  });
});
