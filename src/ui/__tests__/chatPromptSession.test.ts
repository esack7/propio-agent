import { PassThrough } from "stream";
import {
  createChatPromptSession,
  type ChatPromptSessionState,
} from "../chatPromptSession.js";
import type { TypeaheadProvider } from "../typeahead.js";

describe("chatPromptSession", () => {
  it("shows mention typeahead while typing @ without replacing the buffer", () => {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    let latestState: ChatPromptSessionState | undefined;

    (
      inputStream as NodeJS.ReadStream & {
        setRawMode: (mode: boolean) => void;
      }
    ).setRawMode = () => {};
    (
      outputStream as NodeJS.WriteStream & {
        isTTY: boolean;
        columns: number;
      }
    ).isTTY = false;
    (
      outputStream as NodeJS.WriteStream & {
        isTTY: boolean;
        columns: number;
      }
    ).columns = 80;

    const mentionProvider: TypeaheadProvider = {
      kind: "mention",
      getSuggestions: (target) =>
        target.query === ""
          ? [{ kind: "mention", value: "@src/", isDirectory: true }]
          : [],
    };

    const session = createChatPromptSession({
      inputStream: inputStream as unknown as NodeJS.ReadStream,
      outputStream: outputStream as unknown as NodeJS.WriteStream,
      request: {
        promptText: ">",
        mode: "chat",
      },
      historySnapshot: [],
      enableTypeahead: true,
      enableReverseHistorySearch: false,
      workspaceRoot: "/tmp/workspace",
      typeaheadProviders: [mentionProvider],
      callbacks: {
        render: (state) => {
          latestState = state;
        },
        submit: () => {
          /* no-op */
        },
        interrupt: () => {
          /* no-op */
        },
        close: () => {
          /* no-op */
        },
      },
    });

    try {
      inputStream.emit("keypress", "@", {
        name: "@",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(latestState).toMatchObject({
        buffer: "@",
        typeahead: {
          kind: "mention",
          match: "@src/",
          matchCount: 1,
        },
      });

      inputStream.emit("keypress", "\t", {
        name: "tab",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(latestState).toMatchObject({
        buffer: "@src/",
      });
    } finally {
      session.cleanup();
    }
  });

  it("retries mention typeahead when the first search has no matches", () => {
    jest.useFakeTimers();

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    let latestState: ChatPromptSessionState | undefined;
    let calls = 0;

    (
      inputStream as NodeJS.ReadStream & {
        setRawMode: (mode: boolean) => void;
      }
    ).setRawMode = () => {};
    (
      outputStream as NodeJS.WriteStream & {
        isTTY: boolean;
        columns: number;
      }
    ).isTTY = false;
    (
      outputStream as NodeJS.WriteStream & {
        isTTY: boolean;
        columns: number;
      }
    ).columns = 80;

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

    const session = createChatPromptSession({
      inputStream: inputStream as unknown as NodeJS.ReadStream,
      outputStream: outputStream as unknown as NodeJS.WriteStream,
      request: {
        promptText: ">",
        mode: "chat",
      },
      historySnapshot: [],
      enableTypeahead: true,
      enableReverseHistorySearch: false,
      workspaceRoot: "/tmp/workspace",
      typeaheadProviders: [mentionProvider],
      callbacks: {
        render: (state) => {
          latestState = state;
        },
        submit: () => {
          /* no-op */
        },
        interrupt: () => {
          /* no-op */
        },
        close: () => {
          /* no-op */
        },
      },
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

      expect(latestState).toMatchObject({
        buffer: "@s",
        typeahead: {
          kind: "mention",
          matchCount: 0,
        },
      });

      jest.advanceTimersByTime(100);

      expect(latestState).toMatchObject({
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
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    const renderedBuffers: string[] = [];

    (
      inputStream as NodeJS.ReadStream & {
        setRawMode: (mode: boolean) => void;
      }
    ).setRawMode = () => {};
    (
      outputStream as NodeJS.WriteStream & {
        isTTY: boolean;
        columns: number;
      }
    ).isTTY = false;
    (
      outputStream as NodeJS.WriteStream & {
        isTTY: boolean;
        columns: number;
      }
    ).columns = 80;

    const mentionProvider: TypeaheadProvider = {
      kind: "mention",
      getSuggestions: (target) =>
        target.query === "d"
          ? [{ kind: "mention", value: "@docs/", isDirectory: true }]
          : [],
    };

    const session = createChatPromptSession({
      inputStream: inputStream as unknown as NodeJS.ReadStream,
      outputStream: outputStream as unknown as NodeJS.WriteStream,
      request: {
        promptText: ">",
        mode: "chat",
      },
      historySnapshot: [],
      enableTypeahead: true,
      enableReverseHistorySearch: false,
      workspaceRoot: "/tmp/workspace",
      typeaheadProviders: [mentionProvider],
      callbacks: {
        render: (state) => {
          renderedBuffers.push(state.buffer);
        },
        submit: () => {
          /* no-op */
        },
        interrupt: () => {
          /* no-op */
        },
        close: () => {
          /* no-op */
        },
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
});
