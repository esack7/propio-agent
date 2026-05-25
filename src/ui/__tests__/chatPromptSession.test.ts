import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "stream";
import {
  createChatPromptSession,
  type ChatPromptSessionState,
  type ChatPromptSession,
} from "../chatPromptSession.js";
import type { TypeaheadProvider } from "../typeahead.js";
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
} from "../input/bracketedPaste.js";
import { PASTE_END, PASTE_START } from "../input/parseKeypress.js";
import { PASTE_THRESHOLD } from "../input/constants.js";
import { isImageOnlySubmission } from "../input/promptSubmission.js";
import { createPasteCache, type PasteCache } from "../pasteCache.js";
import { createTtyTestStream, withKeypressEvents } from "./ttyTestStream.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function expectSubmitPrompt(
  submit: jest.Mock,
  expected: {
    text: string;
    displayText?: string;
    inputMode?: "prompt" | "bash";
  },
): void {
  expect(submit).toHaveBeenCalledWith({
    text: expected.text,
    displayText: expected.displayText ?? expected.text,
    inputMode: expected.inputMode ?? "prompt",
  });
}

interface TestSessionOptions {
  typeaheadProviders?: TypeaheadProvider[];
  onRender?: (state: ChatPromptSessionState) => void;
  toggleToolCalls?: () => string | null | undefined;
  toggleThinking?: () => string | null | undefined;
  refreshPromptFooters?: () => { prompt: string; bash: string };
  enableTypeahead?: boolean;
  enableReverseHistorySearch?: boolean;
  historySnapshot?: string[];
  inputMode?: "prompt" | "bash";
  editorRunner?: unknown;
  outputStream?: NodeJS.WriteStream & { chunks?: string[] };
  terminalControlStream?: NodeJS.WriteStream & { chunks?: string[] };
  inputStream?: PassThrough;
  submit?: (
    submission: import("../input/promptSubmission.js").PromptSubmission,
  ) => void;
  interrupt?: () => void;
  close?: () => void;
  pasteCache?: PasteCache;
}

function createRawModeInputStream(): PassThrough {
  const inputStream = new PassThrough();
  (
    inputStream as NodeJS.ReadStream & { setRawMode: (mode: boolean) => void }
  ).setRawMode = () => {};
  return inputStream;
}

function createPromptOutputStream(
  outputStream: TestSessionOptions["outputStream"],
): NodeJS.WriteStream {
  const stream = outputStream ?? new PassThrough();
  (stream as NodeJS.WriteStream & { isTTY: boolean }).isTTY ??= false;
  (stream as NodeJS.WriteStream & { columns: number }).columns = 80;
  return stream as NodeJS.WriteStream;
}

function createPromptRequest(options: TestSessionOptions) {
  return {
    promptText: ">",
    bashPromptText: "! ",
    footer: "idle footer",
    bashFooter: "bash footer",
    mode: "chat" as const,
    inputMode: options.inputMode,
  };
}

function createPromptCallbacks(
  options: TestSessionOptions,
  setLatestState: (state: ChatPromptSessionState) => void,
) {
  return {
    render: (state: ChatPromptSessionState) => {
      setLatestState(state);
      options.onRender?.(state);
    },
    submit: options.submit ?? (() => {}),
    interrupt: options.interrupt ?? (() => {}),
    close: options.close ?? (() => {}),
    toggleToolCalls: options.toggleToolCalls,
    toggleThinking: options.toggleThinking,
    refreshPromptFooters: options.refreshPromptFooters,
  };
}

function emitPlainKey(inputStream: PassThrough, name: string): void {
  inputStream.emit("keypress", "", {
    name,
    ctrl: false,
    meta: false,
    shift: false,
  });
}

function emitChar(inputStream: PassThrough, character: string): void {
  inputStream.emit("keypress", character, {
    sequence: character,
    name: character,
    ctrl: false,
    meta: false,
    shift: false,
  });
}

function emitCtrlKey(inputStream: PassThrough, name: string): void {
  inputStream.emit("keypress", "", {
    name,
    ctrl: true,
    meta: false,
    shift: false,
  });
}

function createRootMentionProvider(): TypeaheadProvider {
  return {
    kind: "mention",
    getSuggestions: (target) =>
      target.query === ""
        ? [{ kind: "mention", value: "@src/", isDirectory: true }]
        : [],
  };
}

function expectBashHistoryReplay(options: TestSessionOptions = {}): void {
  const { inputStream, session, getState } = createTestSession({
    ...options,
    historySnapshot: ["!git status"],
  });

  try {
    emitPlainKey(inputStream, "up");
    expect(getState()).toMatchObject({
      inputMode: "bash",
      buffer: "git status",
    });
  } finally {
    session.cleanup();
  }
}

function createNonTtyControlStream(): NodeJS.WriteStream {
  const stream = new PassThrough();
  (stream as NodeJS.WriteStream & { isTTY: boolean }).isTTY = false;
  return stream as NodeJS.WriteStream;
}

function createTestSession(options: TestSessionOptions = {}): {
  inputStream: PassThrough;
  session: ChatPromptSession;
  getState: () => ChatPromptSessionState | undefined;
  terminalControlStream: NodeJS.WriteStream & { chunks?: string[] };
} {
  const inputStream = options.inputStream ?? createRawModeInputStream();
  const outputStream = createPromptOutputStream(options.outputStream);
  const terminalControlStream =
    options.terminalControlStream ?? createNonTtyControlStream();
  let latestState: ChatPromptSessionState | undefined;

  const session = createChatPromptSession({
    inputStream: inputStream as unknown as NodeJS.ReadStream,
    outputStream: outputStream as unknown as NodeJS.WriteStream,
    terminalControlStream,
    request: createPromptRequest(options),
    historySnapshot: options.historySnapshot ?? [],
    enableTypeahead: options.enableTypeahead ?? true,
    enableReverseHistorySearch: options.enableReverseHistorySearch ?? false,
    workspaceRoot: "/tmp/workspace",
    typeaheadProviders: options.typeaheadProviders ?? [],
    editorRunner: options.editorRunner as never,
    pasteCache: options.pasteCache,
    callbacks: createPromptCallbacks(options, (state) => {
      latestState = state;
    }),
  });

  return {
    inputStream,
    session,
    getState: () => latestState,
    terminalControlStream: terminalControlStream as NodeJS.WriteStream & {
      chunks?: string[];
    },
  };
}

function createPasteInputSession(options: TestSessionOptions = {}) {
  return createTestSession({
    enableTypeahead: false,
    ...options,
    inputStream: withKeypressEvents(createRawModeInputStream()),
  });
}

function expectCachedPasteHistoryReplay(
  historyEntry: string,
  body: string,
  expectedInputMode: "prompt" | "bash",
): void {
  const pasteCache = createPasteCache({
    cacheDir: path.join(os.tmpdir(), `propio-chat-paste-${Date.now()}`),
  });
  const hash = pasteCache.store(body);

  const { inputStream, session, getState } = createTestSession({
    historySnapshot: [historyEntry.replace("{hash}", hash)],
    pasteCache,
    enableTypeahead: false,
  });

  try {
    emitPlainKey(inputStream, "up");
    expect(getState()).toMatchObject({
      inputMode: expectedInputMode,
      buffer: body,
      cursor: body.length,
    });
  } finally {
    session.cleanup();
  }
}

describe("chatPromptSession", () => {
  it("shows mention typeahead while typing @ without replacing the buffer", () => {
    const { inputStream, session, getState } = createTestSession({
      typeaheadProviders: [createRootMentionProvider()],
    });

    try {
      inputStream.emit("keypress", "@", {
        name: "@",
        ctrl: false,
        meta: false,
        shift: false,
      });
      expect(getState()).toMatchObject({
        buffer: "@",
        typeahead: { kind: "mention", match: "@src/", matchCount: 1 },
      });
      inputStream.emit("keypress", "\t", {
        name: "tab",
        ctrl: false,
        meta: false,
        shift: false,
      });
      expect(getState()).toMatchObject({ buffer: "@src/" });
    } finally {
      session.cleanup();
    }
  });

  it("invokes the tool-call toggle callback on Ctrl+O without changing the buffer", () => {
    const toggleToolCalls = jest.fn();
    const { inputStream, session, getState } = createTestSession({
      toggleToolCalls,
    });

    try {
      inputStream.emit("keypress", "o", {
        name: "o",
        ctrl: true,
        meta: false,
        shift: false,
      });
      expect(toggleToolCalls).toHaveBeenCalledTimes(1);
    } finally {
      session.cleanup();
    }
  });

  it("invokes the thinking toggle callback on Ctrl+T without changing the buffer", () => {
    const toggleThinking = jest.fn();
    const { inputStream, session } = createTestSession({
      toggleThinking,
    });

    try {
      inputStream.emit("keypress", "t", {
        name: "t",
        ctrl: true,
        meta: false,
        shift: false,
      });
      expect(toggleThinking).toHaveBeenCalledTimes(1);
    } finally {
      session.cleanup();
    }
  });

  it("clears a pending Ctrl+X editor chord before handling Ctrl+O", () => {
    const toggleToolCalls = jest.fn();
    const editorRunner = jest.fn(() => ({ status: 0, signal: null }));
    const { inputStream, session, getState } = createTestSession({
      enableTypeahead: false,
      toggleToolCalls,
      editorRunner,
    });

    try {
      inputStream.emit("keypress", undefined, {
        name: "x",
        ctrl: true,
        meta: false,
        shift: false,
      });
      inputStream.emit("keypress", undefined, {
        name: "o",
        ctrl: true,
        meta: false,
        shift: false,
      });
      inputStream.emit("keypress", undefined, {
        name: "e",
        ctrl: true,
        meta: false,
        shift: false,
      });

      expect(toggleToolCalls).toHaveBeenCalledTimes(1);
      expect(editorRunner).not.toHaveBeenCalled();
      expect(getState()).toMatchObject({
        buffer: "",
        cursor: 0,
      });
    } finally {
      session.cleanup();
    }
  });

  it("retries mention typeahead when the first search has no matches", () => {
    jest.useFakeTimers();

    let calls = 0;

    const mentionProvider: TypeaheadProvider = {
      kind: "mention",
      getSuggestions: (target) => {
        if (target.query !== "s") {
          return [];
        }

        calls += 1;
        return calls === 1
          ? []
          : [{ kind: "mention", value: "@src/", isDirectory: true }];
      },
    };

    const { inputStream, session, getState } = createTestSession({
      typeaheadProviders: [mentionProvider],
    });

    try {
      inputStream.emit("keypress", "@", {
        name: "@",
        ctrl: false,
        meta: false,
        shift: false,
      });
      inputStream.emit("keypress", "s", {
        name: "s",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(getState()).toMatchObject({
        buffer: "@s",
        typeahead: {
          kind: "mention",
          matchCount: 0,
        },
      });

      jest.advanceTimersByTime(100);

      expect(getState()).toMatchObject({
        buffer: "@s",
        typeahead: {
          kind: "mention",
          match: "@src/",
          matchCount: 1,
        },
      });
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("keeps directory typeahead alive on the accepted path baseline", () => {
    const renderedBuffers: string[] = [];

    const mentionProvider: TypeaheadProvider = {
      kind: "mention",
      getSuggestions: (target) =>
        target.query === "d"
          ? [{ kind: "mention", value: "@docs/", isDirectory: true }]
          : [],
    };

    const { inputStream, session } = createTestSession({
      typeaheadProviders: [mentionProvider],
      onRender: (state) => {
        renderedBuffers.push(state.buffer);
      },
    });

    try {
      inputStream.emit("keypress", "@", {
        name: "@",
        ctrl: false,
        meta: false,
        shift: false,
      });
      inputStream.emit("keypress", "d", {
        name: "d",
        ctrl: false,
        meta: false,
        shift: false,
      });
      inputStream.emit("keypress", "\t", {
        name: "tab",
        ctrl: false,
        meta: false,
        shift: false,
      });
      inputStream.emit("keypress", "r", {
        name: "r",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(renderedBuffers[renderedBuffers.length - 1]).toBe("@docs/r");
    } finally {
      session.cleanup();
    }
  });

  it("navigates mention matches with arrow keys before accepting", () => {
    const mentionProvider: TypeaheadProvider = {
      kind: "mention",
      getSuggestions: (target) =>
        target.query === "PLAN"
          ? [
              { kind: "mention", value: "@docs/PLAN-openrouter.md " },
              { kind: "mention", value: "@docs/PLAN-file-search.md " },
              { kind: "mention", value: "@docs/PLAN-startup.md " },
            ]
          : [],
    };

    const { inputStream, session, getState } = createTestSession({
      historySnapshot: ["previous prompt"],
      typeaheadProviders: [mentionProvider],
    });

    try {
      for (const character of "@PLAN") {
        inputStream.emit("keypress", character, {
          name: character,
          ctrl: false,
          meta: false,
          shift: false,
        });
      }

      expect(getState()).toMatchObject({
        buffer: "@PLAN",
        typeahead: {
          kind: "mention",
          match: "@docs/PLAN-openrouter.md ",
          matchIndex: 0,
          matchCount: 3,
        },
      });

      inputStream.emit("keypress", undefined, {
        name: "down",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(getState()).toMatchObject({
        buffer: "@PLAN",
        typeahead: {
          match: "@docs/PLAN-file-search.md ",
          matchIndex: 1,
          matchCount: 3,
        },
      });

      inputStream.emit("keypress", "\t", {
        name: "tab",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(getState()).toMatchObject({
        buffer: "@docs/PLAN-file-search.md ",
        cursor: "@docs/PLAN-file-search.md ".length,
      });
      expect(getState()?.typeahead).toBeUndefined();
    } finally {
      session.cleanup();
    }
  });

  it("enters bash mode when typing a leading exclamation", () => {
    const submit = jest.fn();
    const { inputStream, session, getState } = createTestSession({ submit });

    try {
      inputStream.emit("keypress", "!", {
        name: "!",
        ctrl: false,
        meta: false,
        shift: false,
      });
      expect(getState()).toMatchObject({
        inputMode: "bash",
        buffer: "",
        footer: "bash footer",
      });
    } finally {
      session.cleanup();
    }
  });

  it("keeps toggled visibility when entering and exiting bash mode", () => {
    let showToolCalls = true;
    const refreshPromptFooters = () => ({
      prompt: showToolCalls ? "idle shown" : "idle hidden",
      bash: showToolCalls ? "bash shown" : "bash hidden",
    });
    const toggleToolCalls = jest.fn(() => {
      showToolCalls = !showToolCalls;
      return showToolCalls ? "idle shown" : "idle hidden";
    });

    const { inputStream, session, getState } = createTestSession({
      toggleToolCalls,
      refreshPromptFooters,
    });

    try {
      inputStream.emit("keypress", "o", {
        name: "o",
        ctrl: true,
        meta: false,
        shift: false,
      });
      expect(getState()?.footer).toBe("idle hidden");

      inputStream.emit("keypress", "!", {
        name: "!",
        ctrl: false,
        meta: false,
        shift: false,
      });
      expect(getState()?.footer).toBe("bash hidden");

      inputStream.emit("keypress", "", {
        name: "escape",
        ctrl: false,
        meta: false,
        shift: false,
      });
      expect(getState()).toMatchObject({
        inputMode: "prompt",
        footer: "idle hidden",
      });
    } finally {
      session.cleanup();
    }
  });

  it("restores the idle footer after Escape exits bash mode", () => {
    const { inputStream, session, getState } = createTestSession({
      inputMode: "bash",
    });

    try {
      expect(getState()?.footer).toBe("bash footer");
      inputStream.emit("keypress", "", {
        name: "escape",
        ctrl: false,
        meta: false,
        shift: false,
      });
      expect(getState()).toMatchObject({
        inputMode: "prompt",
        footer: "idle footer",
      });
    } finally {
      session.cleanup();
    }
  });

  it("enters bash mode when pasting !pwd", () => {
    jest.useFakeTimers();
    const { inputStream, session, getState } = createTestSession();

    try {
      inputStream.emit("keypress", "!pwd", {
        sequence: "!pwd",
        ctrl: false,
        meta: false,
        shift: false,
      });
      jest.advanceTimersByTime(25);
      expect(getState()).toMatchObject({
        inputMode: "bash",
        buffer: "pwd",
      });
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("inserts bracketed paste emitted by readline in one shot", () => {
    const { inputStream, session, getState } = createPasteInputSession();

    try {
      jest.useFakeTimers();
      inputStream.write(`${PASTE_START}line one\nline two${PASTE_END}`);
      jest.advanceTimersByTime(101);
      expect(getState()).toMatchObject({
        buffer: "line one\nline two",
      });
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("collapses large bracketed paste into a placeholder pill", () => {
    const { inputStream, session, getState } = createPasteInputSession();

    try {
      jest.useFakeTimers();
      const largePaste = "x".repeat(PASTE_THRESHOLD + 1);
      inputStream.write(`${PASTE_START}${largePaste}${PASTE_END}`);
      jest.advanceTimersByTime(101);
      expect(getState()?.buffer).toBe("[Pasted text #1]");
      expect(getState()?.buffer).not.toContain(largePaste);
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("expands pasted placeholders on submit", () => {
    jest.useFakeTimers();
    const submit = jest.fn();
    const inputStream = withKeypressEvents(createRawModeInputStream());
    const outputStream = createPromptOutputStream();
    const terminalControlStream = createNonTtyControlStream();

    const session = createChatPromptSession({
      inputStream: inputStream as unknown as NodeJS.ReadStream,
      outputStream,
      terminalControlStream,
      request: createPromptRequest({}),
      historySnapshot: [],
      enableTypeahead: false,
      enableReverseHistorySearch: false,
      workspaceRoot: "/tmp/workspace",
      typeaheadProviders: [],
      callbacks: createPromptCallbacks({ submit }, () => {}),
    });

    try {
      const largePaste = "y".repeat(PASTE_THRESHOLD + 1);
      inputStream.write(`${PASTE_START}${largePaste}${PASTE_END}`);
      jest.advanceTimersByTime(101);
      emitPlainKey(inputStream, "return");
      expectSubmitPrompt(submit, {
        displayText: "[Pasted text #1]",
        text: largePaste,
      });
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("does not submit while a debounced paste is active", () => {
    jest.useFakeTimers();
    const submit = jest.fn();
    const { inputStream, session, getState } = createPasteInputSession({
      submit,
    });

    try {
      inputStream.write(`${PASTE_START}draft${PASTE_END}`);
      inputStream.emit("keypress", "", {
        name: "return",
        ctrl: false,
        meta: false,
        shift: false,
      });
      expect(submit).not.toHaveBeenCalled();
      expect(getState()?.buffer).toBe("");

      jest.advanceTimersByTime(101);
      expect(getState()?.buffer).toBe("draft");

      inputStream.emit("keypress", "", {
        name: "return",
        ctrl: false,
        meta: false,
        shift: false,
      });
      expectSubmitPrompt(submit, { text: "draft" });
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("does not submit while burst paste is active", () => {
    jest.useFakeTimers();
    const submit = jest.fn();
    const { inputStream, session, getState } = createTestSession({ submit });

    try {
      inputStream.emit("keypress", "ab", {
        sequence: "ab",
        ctrl: false,
        meta: false,
        shift: false,
      });
      emitPlainKey(inputStream, "return");
      expect(submit).not.toHaveBeenCalled();
      expect(getState()?.buffer).toBe("");

      jest.advanceTimersByTime(25);
      expect(getState()?.buffer).toBe("ab");

      emitPlainKey(inputStream, "return");
      expect(submit).toHaveBeenCalled();
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("batches rapid single-character input without retro-capture", () => {
    jest.useFakeTimers();
    const { inputStream, session, getState } = createTestSession({
      enableTypeahead: false,
    });

    try {
      emitChar(inputStream, "a");
      expect(getState()?.buffer).toBe("a");

      jest.advanceTimersByTime(5);
      emitChar(inputStream, "b");
      jest.advanceTimersByTime(5);
      emitChar(inputStream, "c");
      expect(getState()?.buffer).toBe("a");

      jest.advanceTimersByTime(25);
      expect(getState()?.buffer).toBe("abc");
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("does not submit while a single-character burst is active", () => {
    jest.useFakeTimers();
    const submit = jest.fn();
    const { inputStream, session, getState } = createTestSession({
      submit,
      enableTypeahead: false,
    });

    try {
      emitChar(inputStream, "a");
      jest.advanceTimersByTime(5);
      emitChar(inputStream, "b");
      jest.advanceTimersByTime(1);
      emitPlainKey(inputStream, "return");

      expect(submit).not.toHaveBeenCalled();
      expect(getState()?.buffer).toBe("a");

      jest.advanceTimersByTime(25);
      expect(getState()?.buffer).toBe("ab");

      emitPlainKey(inputStream, "return");
      expectSubmitPrompt(submit, { text: "ab" });
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("skips burst while reverse history search is active", () => {
    jest.useFakeTimers();
    const { inputStream, session, getState } = createTestSession({
      enableReverseHistorySearch: true,
      enableTypeahead: false,
      historySnapshot: ["hello world"],
    });

    try {
      emitCtrlKey(inputStream, "r");
      expect(getState()?.historySearch?.active).toBe(true);

      jest.advanceTimersByTime(5);
      emitChar(inputStream, "a");
      emitChar(inputStream, "b");

      expect(getState()).toMatchObject({
        historySearch: {
          active: true,
          query: "ab",
        },
      });
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("skips burst while mention typeahead is active", () => {
    jest.useFakeTimers();
    const { inputStream, session, getState } = createTestSession({
      typeaheadProviders: [createRootMentionProvider()],
    });

    try {
      emitChar(inputStream, "@");
      jest.advanceTimersByTime(5);
      emitChar(inputStream, "a");
      emitChar(inputStream, "b");

      expect(getState()).toMatchObject({
        buffer: "@ab",
        typeahead: {
          kind: "mention",
        },
      });
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("skips burst while history navigation is active", () => {
    const { inputStream, session, getState } = createTestSession({
      enableTypeahead: false,
      historySnapshot: ["previous prompt"],
    });

    try {
      emitPlainKey(inputStream, "up");
      expect(getState()?.buffer).toBe("previous prompt");

      emitChar(inputStream, "!");
      expect(getState()?.buffer).toBe("previous prompt!");
    } finally {
      session.cleanup();
    }
  });

  it("does not deliver paste after cleanup", () => {
    jest.useFakeTimers();
    const { inputStream, session, getState } = createPasteInputSession();

    try {
      inputStream.write(`${PASTE_START}delayed${PASTE_END}`);
      expect(getState()?.buffer).toBe("");
      session.cleanup();
      jest.advanceTimersByTime(200);
      expect(getState()?.buffer).toBe("");
    } finally {
      jest.useRealTimers();
    }
  });

  it("enables bracketed paste on attach and disables on cleanup for TTY control streams", () => {
    const terminalControlStream = createTtyTestStream(true);
    const { session } = createTestSession({ terminalControlStream });

    expect(terminalControlStream.chunks).toEqual([BRACKETED_PASTE_ENABLE]);

    session.cleanup();

    expect(terminalControlStream.chunks).toEqual([
      BRACKETED_PASTE_ENABLE,
      BRACKETED_PASTE_DISABLE,
    ]);
  });

  it("replays bash history without a visible exclamation prefix", () => {
    expectBashHistoryReplay();
  });

  it("replays bash history without a visible exclamation prefix from bash mode", () => {
    expectBashHistoryReplay({ inputMode: "bash" });
  });

  it("exits bash mode on Escape when search and typeahead are inactive", () => {
    const { inputStream, session, getState } = createTestSession({
      inputMode: "bash",
    });

    try {
      emitPlainKey(inputStream, "escape");
      expect(getState()).toMatchObject({ inputMode: "prompt" });
    } finally {
      session.cleanup();
    }
  });

  it("exits bash mode on Backspace when the bash buffer is empty", () => {
    const { inputStream, session, getState } = createTestSession({
      inputMode: "bash",
    });

    try {
      emitPlainKey(inputStream, "backspace");

      expect(getState()).toMatchObject({
        inputMode: "prompt",
        buffer: "",
        footer: "idle footer",
      });
    } finally {
      session.cleanup();
    }
  });

  it("keeps bash mode while Backspace deletes command text", () => {
    const { inputStream, session, getState } = createTestSession({
      inputMode: "bash",
    });

    try {
      inputStream.emit("keypress", "p", {
        sequence: "p",
        ctrl: false,
        meta: false,
        shift: false,
      });
      emitPlainKey(inputStream, "backspace");

      expect(getState()).toMatchObject({
        inputMode: "bash",
        buffer: "",
        footer: "bash footer",
      });

      emitPlainKey(inputStream, "backspace");

      expect(getState()).toMatchObject({
        inputMode: "prompt",
        buffer: "",
        footer: "idle footer",
      });
    } finally {
      session.cleanup();
    }
  });

  it("exits bash mode on Delete when the bash buffer is empty", () => {
    const { inputStream, session, getState } = createTestSession({
      inputMode: "bash",
    });

    try {
      emitPlainKey(inputStream, "delete");

      expect(getState()).toMatchObject({
        inputMode: "prompt",
        buffer: "",
        footer: "idle footer",
      });
    } finally {
      session.cleanup();
    }
  });

  it("submits with bash input mode", () => {
    jest.useFakeTimers();
    const submit = jest.fn();
    const { inputStream, session } = createTestSession({
      inputMode: "bash",
      submit,
    });

    try {
      inputStream.emit("keypress", "pwd", {
        sequence: "pwd",
        ctrl: false,
        meta: false,
        shift: false,
      });
      jest.advanceTimersByTime(25);
      inputStream.emit("keypress", "\r", {
        name: "return",
        ctrl: false,
        meta: false,
        shift: false,
      });
      expectSubmitPrompt(submit, { text: "pwd", inputMode: "bash" });
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("clears the live bash prompt instead of writing a duplicate submitted line", () => {
    jest.useFakeTimers();
    const submit = jest.fn();
    const outputStream = createTtyTestStream(true, 80);
    const { inputStream, session } = createTestSession({
      inputMode: "bash",
      outputStream,
      submit,
    });

    try {
      inputStream.emit("keypress", "pwd", {
        sequence: "pwd",
        ctrl: false,
        meta: false,
        shift: false,
      });
      jest.advanceTimersByTime(25);
      outputStream.chunks.length = 0;

      inputStream.emit("keypress", "\r", {
        name: "return",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(outputStream.chunks.join("")).not.toBe("\n");
      expectSubmitPrompt(submit, { text: "pwd", inputMode: "bash" });
    } finally {
      session.cleanup();
      jest.useRealTimers();
    }
  });

  it("pastes an image file path into a pill and expands on submit", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "propio-chat-image-"),
    );
    const pngPath = path.join(tempDir, "photo.png");
    await fs.writeFile(pngPath, PNG_BYTES);

    const submit = jest.fn();
    const { inputStream, session, getState } = createPasteInputSession({
      submit,
    });

    try {
      inputStream.write(`${PASTE_START}${pngPath}${PASTE_END}`);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(getState()?.buffer).toBe("[Image #1]");

      emitPlainKey(inputStream, "return");
      expect(submit).toHaveBeenCalledTimes(1);
      const submission = submit.mock.calls[0][0];
      expect(submission.displayText).toBe("[Image #1]");
      expect(submission.text).toBe("[Attached image: photo.png]");
      expect(submission.images?.[0]).toMatch(/^data:image\/png;base64,/);
      expect(isImageOnlySubmission(submission)).toBe(true);
    } finally {
      session.cleanup();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restores cached chat paste refs from history navigation", () => {
    const body = "x".repeat(1200);
    expectCachedPasteHistoryReplay("paste:{hash}", body, "prompt");
  });

  it("restores cached bash paste refs from history navigation", () => {
    const body = "git status --long ".repeat(80);
    expectCachedPasteHistoryReplay("!paste:{hash}", body, "bash");
  });

  it("keeps bash draft mode when canceling reverse history search", () => {
    const { inputStream, session, getState } = createTestSession({
      inputMode: "bash",
      enableReverseHistorySearch: true,
      enableTypeahead: false,
      historySnapshot: ["!git log"],
    });

    try {
      emitChar(inputStream, "g");
      emitChar(inputStream, "i");
      emitChar(inputStream, "t");
      emitChar(inputStream, " ");
      emitChar(inputStream, "s");
      emitChar(inputStream, "t");
      emitChar(inputStream, "a");
      emitChar(inputStream, "t");
      emitChar(inputStream, "u");
      emitChar(inputStream, "s");
      emitCtrlKey(inputStream, "r");
      emitPlainKey(inputStream, "escape");

      expect(getState()).toMatchObject({
        inputMode: "bash",
        buffer: "git status",
      });
    } finally {
      session.cleanup();
    }
  });

  it("restores bash body when accepting a !paste ref from reverse history search", () => {
    const pasteCache = createPasteCache({
      cacheDir: path.join(
        os.tmpdir(),
        `propio-chat-search-paste-${Date.now()}`,
      ),
    });
    const body = "npm test -- --watch";
    const hash = pasteCache.store(body);

    const { inputStream, session, getState } = createTestSession({
      enableReverseHistorySearch: true,
      enableTypeahead: false,
      historySnapshot: [`!paste:${hash}`],
      pasteCache,
    });

    try {
      emitCtrlKey(inputStream, "r");
      emitPlainKey(inputStream, "return");

      expect(getState()).toMatchObject({
        inputMode: "bash",
        buffer: body,
        cursor: body.length,
      });
    } finally {
      session.cleanup();
    }
  });
});
