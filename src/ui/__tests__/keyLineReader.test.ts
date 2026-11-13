import { EventEmitter } from "events";
import { readLineFromKeys } from "../keyLineReader.js";

/** A terminal input that reports keys, as readline does for a real TTY. */
function fakeInput(isRaw: boolean) {
  const emitter = new EventEmitter() as EventEmitter & {
    isRaw: boolean;
    setRawMode: jest.Mock;
    resume: jest.Mock;
    key: (text: string | undefined, key: Record<string, unknown>) => void;
    type: (text: string) => void;
    enter: () => void;
  };
  emitter.isRaw = isRaw;
  emitter.setRawMode = jest.fn((mode: boolean) => {
    emitter.isRaw = mode;
  });
  emitter.resume = jest.fn();
  emitter.key = (text, key) => emitter.emit("keypress", text, key);
  emitter.type = (text) => {
    for (const character of text) emitter.key(character, { name: character });
  };
  emitter.enter = () => emitter.key("\r", { name: "return" });
  return emitter;
}

function setup(isRaw = true) {
  const input = fakeInput(isRaw);
  const written: string[] = [];
  const output = { write: (chunk: string) => written.push(chunk) > 0 };
  return {
    input,
    written,
    read: (signal?: AbortSignal) =>
      readLineFromKeys(
        { input: input as unknown as NodeJS.ReadStream, output },
        "Allow? ",
        signal,
      ),
  };
}

describe("readLineFromKeys", () => {
  it("writes the prompt, echoes what is typed, and resolves on Enter", async () => {
    const { input, written, read } = setup();
    const line = read();

    input.type("n no thanks");
    input.enter();

    await expect(line).resolves.toBe("n no thanks");
    expect(written.join("")).toBe("Allow? n no thanks\n");
  });

  it("edits with Backspace and clears with Ctrl+U", async () => {
    const { input, written, read } = setup();
    const line = read();

    input.type("yx");
    input.key(undefined, { name: "backspace" });
    input.key(undefined, { name: "backspace" });
    input.key(undefined, { name: "backspace" });
    input.type("abc");
    input.key("\x15", { name: "u", ctrl: true });
    input.type("s");
    input.enter();

    await expect(line).resolves.toBe("s");
    expect(written.join("")).toBe(
      `Allow? yx${"\b \b".repeat(2)}abc${"\b \b".repeat(3)}s\n`,
    );
  });

  it("removes a whole character outside the basic plane", async () => {
    const { input, read } = setup();
    const line = read();

    input.key("a", { name: "a" });
    input.key("😀", {});
    input.key(undefined, { name: "backspace" });
    input.enter();

    await expect(line).resolves.toBe("a");
  });

  it("neither echoes nor keeps control keys and escape sequences", async () => {
    const { input, written, read } = setup();
    const line = read();

    input.key("\x1b", { name: "escape" });
    input.key("\x1b[A", { name: "up" });
    input.key("\x01", { name: "a", ctrl: true });
    input.key("f", { name: "f", meta: true });
    input.key("\t", { name: "tab" });
    input.type("y");
    input.enter();

    await expect(line).resolves.toBe("y");
    expect(written.join("")).toBe("Allow? y\n");
  });

  it.each([
    ["Ctrl+C", { name: "c", ctrl: true }],
    ["Ctrl+D", { name: "d", ctrl: true }],
  ])("withdraws the question on %s", async (_label, key) => {
    const { input, read } = setup();
    const line = read();

    input.type("y");
    input.key(undefined, key);

    await expect(line).resolves.toBeNull();
  });

  it("withdraws the question when the signal aborts, and stops listening", async () => {
    const { input, read } = setup();
    const controller = new AbortController();
    const line = read(controller.signal);

    input.type("y");
    controller.abort();

    await expect(line).resolves.toBeNull();
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it("does not ask when the signal is already aborted", async () => {
    const { input, written, read } = setup();

    await expect(read(AbortSignal.abort())).resolves.toBeNull();
    expect(written).toEqual([]);
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it("stops listening once answered, on the keypress and the signal", async () => {
    const { input, read } = setup();
    const controller = new AbortController();
    const { getEventListeners } = await import("events");

    for (let index = 0; index < 5; index += 1) {
      const line = read(controller.signal);
      input.enter();
      await line;
    }

    expect(input.listenerCount("keypress")).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("leaves raw mode as it found it", async () => {
    const raw = setup(true);
    const rawLine = raw.read();
    raw.input.enter();
    await rawLine;
    expect(raw.input.setRawMode).not.toHaveBeenCalled();

    const cooked = setup(false);
    const cookedLine = cooked.read();
    expect(cooked.input.isRaw).toBe(true);
    cooked.input.enter();
    await cookedLine;
    expect(cooked.input.isRaw).toBe(false);
  });
});
