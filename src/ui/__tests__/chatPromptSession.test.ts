import { PassThrough } from "stream";
import {
  createChatPromptSession,
  type ChatPromptSessionState,
  type ChatPromptSession,
} from "../chatPromptSession.js";
import type { TypeaheadProvider } from "../typeahead.js";

function createTestSession(
  options: {
    typeaheadProviders?: TypeaheadProvider[];
    onRender?: (state: ChatPromptSessionState) => void;
    toggleToolCalls?: () => string | null | undefined;
    toggleThinking?: () => string | null | undefined;
    enableTypeahead?: boolean;
    enableReverseHistorySearch?: boolean;
    historySnapshot?: string[];
    editorRunner?: unknown;
    submit?: () => void;
    interrupt?: () => void;
    close?: () => void;
  } = {},
): {
  inputStream: PassThrough;
  session: ChatPromptSession;
  getState: () => ChatPromptSessionState | undefined;
} {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  let latestState: ChatPromptSessionState | undefined;

  (
    inputStream as NodeJS.ReadStream & { setRawMode: (mode: boolean) => void }
  ).setRawMode = () => {};
  (outputStream as NodeJS.WriteStream & { isTTY: boolean }).isTTY = false;
  (outputStream as NodeJS.WriteStream & { columns: number }).columns = 80;

  const session = createChatPromptSession({
    inputStream: inputStream as unknown as NodeJS.ReadStream,
    outputStream: outputStream as unknown as NodeJS.WriteStream,
    request: { promptText: ">", mode: "chat" },
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
});
