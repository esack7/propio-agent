import { PassThrough } from "stream";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { createPromptComposer } from "../promptComposer.js";
import { createPromptHistoryStore } from "../promptHistory.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(renderFooter?: (footer: string) => void) {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  outputStream.setEncoding("utf8");

  const composer = createPromptComposer({
    input: inputStream as unknown as NodeJS.ReadStream,
    output: outputStream as unknown as NodeJS.WriteStream,
    renderFooter,
  });

  return {
    composer,
    inputStream,
    outputStream,
  };
}

function createFakeReadlineHarness() {
  let questionHandler: ((answer: string) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let sigintHandler: (() => void) | null = null;
  let history: string[] = [];

  const fakeRl = {
    get history() {
      return history;
    },
    set history(nextHistory: string[]) {
      history = nextHistory;
    },
    question: jest.fn(
      (_promptText: string, callback: (answer: string) => void) => {
        questionHandler = callback;
      },
    ),
    once: jest.fn((event: string, handler: () => void) => {
      if (event === "close") {
        closeHandler = handler;
      }
      return fakeRl;
    }),
    on: jest.fn((event: string, handler: () => void) => {
      if (event === "SIGINT") {
        sigintHandler = handler;
      }
      return fakeRl;
    }),
    close: jest.fn(() => {
      closeHandler?.();
    }),
  };

  const createInterface = jest.fn(
    (options: { history?: readonly string[] }) => {
      history = [...(options.history ?? [])];
      return fakeRl as unknown as readline.Interface;
    },
  );

  return {
    createInterface,
    fakeRl,
    getHistory: () => [...history],
    submit: (answer: string) => {
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index] === answer) {
          history.splice(index, 1);
        }
      }
      history.unshift(answer);
      questionHandler?.(answer);
    },
    emitSigint: () => {
      sigintHandler?.();
    },
  };
}

describe("createPromptComposer", () => {
  it("exposes the current prompt state while composing", async () => {
    const harness = createHarness();

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
      placeholder: "type here",
      footer: "footer text",
    });

    const activeState = harness.composer.getState();
    expect(activeState).toEqual({
      buffer: "",
      cursor: 0,
      mode: "chat",
      placeholder: "type here",
      footer: "footer text",
      history: undefined,
    });

    await flush();
    harness.inputStream.write("alice\n");

    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "alice",
    });

    expect(harness.composer.getState()).toMatchObject({
      buffer: "alice",
      cursor: 5,
      mode: "chat",
      placeholder: "type here",
      footer: "footer text",
    });

    harness.composer.close();
  });

  it("renders the supplied footer through the injected renderer", async () => {
    const renderFooter = jest.fn();
    const harness = createHarness(renderFooter);

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
      footer: "Idle footer",
    });

    await flush();
    expect(renderFooter).toHaveBeenCalledWith("Idle footer");

    harness.inputStream.write("alice\n");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "alice",
    });

    harness.composer.close();
  });

  it("loads history into readline with duplicate removal enabled", () => {
    const historyStore = {
      load: jest.fn(() => ["recent", "older"]),
      record: jest.fn(),
    };
    const readlineHarness = createFakeReadlineHarness();

    createPromptComposer({
      createInterface: readlineHarness.createInterface,
      historyStore,
    });

    expect(historyStore.load).toHaveBeenCalledTimes(1);
    expect(readlineHarness.createInterface).toHaveBeenCalledWith(
      expect.objectContaining({
        history: ["recent", "older"],
        historySize: 200,
        removeHistoryDuplicates: true,
      }),
    );
  });

  it("records submitted chat input", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-chat-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    const readlineHarness = createFakeReadlineHarness();

    const composer = createPromptComposer({
      createInterface: readlineHarness.createInterface,
      historyStore,
    });

    const prompt = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });

    readlineHarness.submit("hello");

    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "hello",
    });
    expect(historyStore.load()).toEqual(["hello"]);

    composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not record blank input, confirm input, or control commands", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-history-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    const readlineHarness = createFakeReadlineHarness();

    const composer = createPromptComposer({
      createInterface: readlineHarness.createInterface,
      historyStore,
    });

    const blank = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("   ");
    await expect(blank).resolves.toEqual({
      status: "submitted",
      text: "   ",
    });

    const clear = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/clear");
    await expect(clear).resolves.toEqual({
      status: "submitted",
      text: "/clear",
    });

    const confirm = composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    readlineHarness.submit("y");
    await expect(confirm).resolves.toBe(true);

    const exit = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/exit");
    await expect(exit).resolves.toEqual({
      status: "submitted",
      text: "/exit",
    });

    const quit = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/quit");
    await expect(quit).resolves.toEqual({
      status: "submitted",
      text: "/quit",
    });

    expect(historyStore.load()).toEqual([]);

    composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("records useful slash commands", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-slash-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    const readlineHarness = createFakeReadlineHarness();

    const composer = createPromptComposer({
      createInterface: readlineHarness.createInterface,
      historyStore,
    });

    const prompt = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/context");

    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "/context",
    });
    expect(historyStore.load()).toEqual(["/context"]);
    expect(readlineHarness.getHistory()).toEqual(["/context"]);

    composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes skipped submissions from live readline history", async () => {
    const readlineHarness = createFakeReadlineHarness();
    const composer = createPromptComposer({
      createInterface: readlineHarness.createInterface,
    });

    const menu = composer.compose({
      mode: "menu",
      promptText: "Choice? ",
    });
    readlineHarness.submit("1");
    await expect(menu).resolves.toEqual({
      status: "submitted",
      text: "1",
    });
    expect(readlineHarness.getHistory()).toEqual([]);

    const blank = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("   ");
    await expect(blank).resolves.toEqual({
      status: "submitted",
      text: "   ",
    });
    expect(readlineHarness.getHistory()).toEqual([]);

    const clear = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/clear");
    await expect(clear).resolves.toEqual({
      status: "submitted",
      text: "/clear",
    });
    expect(readlineHarness.getHistory()).toEqual([]);

    const confirm = composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    readlineHarness.submit("y");
    await expect(confirm).resolves.toBe(true);
    expect(readlineHarness.getHistory()).toEqual([]);

    const exit = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/exit");
    await expect(exit).resolves.toEqual({
      status: "submitted",
      text: "/exit",
    });
    expect(readlineHarness.getHistory()).toEqual([]);

    composer.close();
  });

  it("restores the prior live history snapshot for skipped duplicate inputs", async () => {
    const historyStore = {
      load: jest.fn(() => ["y"]),
      record: jest.fn(),
    };
    const readlineHarness = createFakeReadlineHarness();
    const composer = createPromptComposer({
      createInterface: readlineHarness.createInterface,
      historyStore,
    });

    const confirm = composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    readlineHarness.submit("y");

    await expect(confirm).resolves.toBe(true);
    expect(readlineHarness.getHistory()).toEqual(["y"]);

    composer.close();
  });
});
