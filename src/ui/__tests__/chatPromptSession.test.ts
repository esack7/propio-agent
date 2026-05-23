import { PassThrough } from "stream";
import {
  createChatPromptSession,
  type ChatPromptSessionState,
  type ChatPromptSession,
} from "../chatPromptSession.js";
import type { TypeaheadProvider } from "../typeahead.js";
import { createTtyTestStream } from "./ttyTestStream.js";

function createTestSession(
  options: {
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
    submit?: (text: string, inputMode: "prompt" | "bash") => void;
    interrupt?: () => void;
    close?: () => void;
  } = {},
): {
  inputStream: PassThrough;
  session: ChatPromptSession;
  getState: () => ChatPromptSessionState | undefined;
} {
  const inputStream = new PassThrough();
  const outputStream = options.outputStream ?? new PassThrough();
  let latestState: ChatPromptSessionState | undefined;

  (
    inputStream as NodeJS.ReadStream & { setRawMode: (mode: boolean) => void }
  ).setRawMode = () => {};
  (outputStream as NodeJS.WriteStream & { isTTY: boolean }).isTTY ??= false;
  (outputStream as NodeJS.WriteStream & { columns: number }).columns = 80;

  const session = createChatPromptSession({
    inputStream: inputStream as unknown as NodeJS.ReadStream,
    outputStream: outputStream as unknown as NodeJS.WriteStream,
    request: {
      promptText: ">",
      bashPromptText: "! ",
      footer: "idle footer",
      bashFooter: "bash footer",
      mode: "chat",
      inputMode: options.inputMode,
    },
    historySnapshot: options.historySnapshot ?? [],
    enableTypeahead: options.enableTypeahead ?? true,
    enableReverseHistorySearch: options.enableReverseHistorySearch ?? false,
    workspaceRoot: "/tmp/workspace",
    typeaheadProviders: options.typeaheadProviders ?? [],
    editorRunner: options.editorRunner as never,
    callbacks: {
      render: (state) => {
        latestState = state;
        options.onRender?.(state);
      },
      submit: options.submit ?? (() => {}),
      interrupt: options.interrupt ?? (() => {}),
      close: options.close ?? (() => {}),
      toggleToolCalls: options.toggleToolCalls,
      toggleThinking: options.toggleThinking,
      refreshPromptFooters: options.refreshPromptFooters,
    },
  });

  return { inputStream, session, getState: () => latestState };
}

describe("chatPromptSession", () => {
  it("shows mention typeahead while typing @ without replacing the buffer", () => {
    const mentionProvider: TypeaheadProvider = {
      kind: "mention",
      getSuggestions: (target) =>
        target.query === ""
          ? [{ kind: "mention", value: "@src/", isDirectory: true }]
          : [],
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
    const { inputStream, session, getState } = createTestSession();

    try {
      inputStream.emit("keypress", "!pwd", {
        sequence: "!pwd",
        ctrl: false,
        meta: false,
        shift: false,
      });
      expect(getState()).toMatchObject({
        inputMode: "bash",
        buffer: "pwd",
      });
    } finally {
      session.cleanup();
    }
  });

  it("replays bash history without a visible exclamation prefix", () => {
    const { inputStream, session, getState } = createTestSession({
      historySnapshot: ["!git status"],
    });

    try {
      inputStream.emit("keypress", "", {
        name: "up",
        ctrl: false,
        meta: false,
        shift: false,
      });
      expect(getState()).toMatchObject({
        inputMode: "bash",
        buffer: "git status",
      });
    } finally {
      session.cleanup();
    }
  });

  it("exits bash mode on Escape when search and typeahead are inactive", () => {
    const { inputStream, session, getState } = createTestSession({
      inputMode: "bash",
    });

    try {
      inputStream.emit("keypress", "", {
        name: "escape",
        ctrl: false,
        meta: false,
        shift: false,
      });
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
      inputStream.emit("keypress", "", {
        name: "backspace",
        ctrl: false,
        meta: false,
        shift: false,
      });

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
      inputStream.emit("keypress", "", {
        name: "backspace",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(getState()).toMatchObject({
        inputMode: "bash",
        buffer: "",
        footer: "bash footer",
      });

      inputStream.emit("keypress", "", {
        name: "backspace",
        ctrl: false,
        meta: false,
        shift: false,
      });

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
      inputStream.emit("keypress", "", {
        name: "delete",
        ctrl: false,
        meta: false,
        shift: false,
      });

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
      inputStream.emit("keypress", "\r", {
        name: "return",
        ctrl: false,
        meta: false,
        shift: false,
      });
      expect(submit).toHaveBeenCalledWith("pwd", "bash");
    } finally {
      session.cleanup();
    }
  });

  it("clears the live bash prompt instead of writing a duplicate submitted line", () => {
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
      outputStream.chunks.length = 0;

      inputStream.emit("keypress", "\r", {
        name: "return",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(outputStream.chunks.join("")).not.toBe("\n");
      expect(submit).toHaveBeenCalledWith("pwd", "bash");
    } finally {
      session.cleanup();
    }
  });
});
