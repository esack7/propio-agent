import { describe, expect, it, jest } from "@jest/globals";
import { createHoldableStream } from "../holdableStream.js";
import { createTurnInput } from "../turnInput.js";
import { createTurnInputLine, type TurnInputLine } from "../turnInputLine.js";
import {
  createTtyInputStream,
  createTtyTestStream,
  withKeypressEvents,
} from "./ttyTestStream.js";

const key = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  ...extra,
});

describe("holdable stream", () => {
  it("passes writes through until held, then releases them in order", () => {
    const target = createTtyTestStream();
    const holdable = createHoldableStream(target);
    holdable.stream.write("one ");

    const hold = holdable.hold()!;
    expect(holdable.held).toBe(true);
    const callback = jest.fn();
    holdable.stream.write("two ", callback);
    holdable.stream.write("three");
    hold.write("[direct]");
    // Held output is not on the terminal yet; the direct write is.
    expect(target.chunks).toEqual(["one ", "[direct]"]);
    expect(callback).toHaveBeenCalledTimes(1);
    // One hold at a time.
    expect(holdable.hold()).toBeNull();

    hold.release();
    hold.release();
    expect(target.chunks).toEqual(["one ", "[direct]", "two ", "three"]);
    expect(holdable.held).toBe(false);
    holdable.stream.write(" four");
    expect(target.chunks.at(-1)).toBe(" four");
  });

  it("looks like the stream it wraps", () => {
    const target = createTtyTestStream(true, 72);
    const { stream } = createHoldableStream(target);
    expect(stream.isTTY).toBe(true);
    expect(stream.columns).toBe(72);
  });

  it("lets other code hook write and put it back, as a spinner does", () => {
    const target = createTtyTestStream();
    const holdable = createHoldableStream(target);
    const { stream } = holdable;

    // A spinner keeps the write it found and installs its own.
    const original = stream.write;
    const seen: string[] = [];
    stream.write = ((chunk: string) => {
      seen.push(chunk);
      return (original as (chunk: string) => boolean).call(
        stream,
        `<${chunk}>`,
      );
    }) as never;

    stream.write("a");
    expect(seen).toEqual(["a"]);
    expect(target.chunks).toEqual(["<a>"]);

    // Held: both the outside write and the hook's own are kept, and each is
    // released the way it was headed.
    const hold = holdable.hold()!;
    stream.write("b");
    (original as (chunk: string) => boolean).call(stream, "frame");
    expect(target.chunks).toEqual(["<a>"]);
    hold.release();
    expect(target.chunks).toEqual(["<a>", "<b>", "frame"]);

    stream.write = original;
    stream.write("c");
    expect(target.chunks.at(-1)).toBe("c");
    // Hooking and restoring many times does not pile up wrappers.
    for (let round = 0; round < 20000; round++) {
      const saved = stream.write;
      stream.write = (() => true) as never;
      stream.write = saved;
    }
    stream.write("d");
    expect(target.chunks.at(-1)).toBe("d");
  });
});

describe("turn input line", () => {
  it("draws under the output, holds it, and puts everything back on close", () => {
    const target = createTtyTestStream(true, 40);
    const holdable = createHoldableStream(target);
    const line = createTurnInputLine(holdable, () => 40);
    holdable.stream.write("streamed tex");

    line.show("guide > hi");
    expect(line.showing).toBe(true);
    // A row is reserved below without losing the column, the place is
    // saved, and the line is drawn on the row below.
    expect(target.chunks.slice(1)).toEqual([
      "\x1bD\x1b[1A\x1b7",
      "\x1b8\x1b[1B\r\x1b[0m\x1b[2Kguide > hi",
    ]);

    holdable.stream.write("t continues");
    line.show("guide > hi!");
    expect(target.chunks.at(-1)).toBe(
      "\x1b8\x1b[1B\r\x1b[0m\x1b[2Kguide > hi!",
    );
    expect(target.chunks.join("")).not.toContain("t continues");

    line.close();
    expect(line.showing).toBe(false);
    // The line is erased, the cursor returns to where the output stopped,
    // and what was held follows from there.
    expect(target.chunks.slice(-2)).toEqual([
      "\x1b8\x1b[1B\r\x1b[0m\x1b[2K\x1b8",
      "t continues",
    ]);
    line.close();
  });

  it("keeps a long line to one row by showing its end", () => {
    const target = createTtyTestStream(true, 20);
    const line = createTurnInputLine(createHoldableStream(target), () => 20);
    line.show(`guide > ${"x".repeat(40)}END`);
    const drawn = target.chunks.at(-1)!.split("\x1b[2K")[1]!;
    expect(Array.from(drawn)).toHaveLength(19);
    expect(drawn.startsWith("…")).toBe(true);
    expect(drawn.endsWith("END")).toBe(true);
    line.close();
  });
});

describe("turn input", () => {
  function setup(
    overrides: Partial<Parameters<typeof createTurnInput>[0]> = {},
    withLine = true,
  ) {
    const input = withKeypressEvents(createTtyInputStream());
    const shown: string[] = [];
    let showing = false;
    const line: TurnInputLine = {
      get showing() {
        return showing;
      },
      show: (text) => {
        showing = true;
        shown.push(text);
      },
      close: () => {
        if (showing) shown.push("<closed>");
        showing = false;
      },
    };
    const guided: string[] = [];
    const onInterrupt = jest.fn();
    const turnInput = createTurnInput({
      input,
      interactiveInput: true,
      line: withLine ? line : null,
      promptText: "guide > ",
      onGuide: (text) => {
        guided.push(text);
        return true;
      },
      onInterrupt,
      ...overrides,
    });
    turnInput.attach();
    const type = (text: string) => {
      for (const character of text)
        input.emit("keypress", character, key(character));
    };
    const press = (name: string, extra?: Record<string, unknown>) =>
      input.emit("keypress", undefined, key(name, extra));
    return { input, turnInput, shown, guided, onInterrupt, type, press, line };
  }

  it("shows what is typed and sends it on Enter without interrupting", () => {
    const { turnInput, shown, guided, onInterrupt, type, press } = setup();
    type("go");
    expect(shown).toEqual(["guide > g", "guide > go"]);

    press("return");
    expect(guided).toEqual(["go"]);
    expect(shown.at(-1)).toBe("<closed>");
    expect(onInterrupt).not.toHaveBeenCalled();

    // The next line starts clean, and more than one can be sent.
    type("x");
    press("return");
    expect(guided).toEqual(["go", "x"]);
    expect(turnInput.detach()).toBe("");
  });

  it("closes the line before announcing that guidance was sent", () => {
    const order: string[] = [];
    const { type, press, shown } = setup({
      onGuide: () => {
        order.push(`guide while ${shown.at(-1)}`);
        return true;
      },
    });
    type("a");
    press("return");
    expect(order).toEqual(["guide while <closed>"]);
  });

  it("edits the line: Backspace, Ctrl+U, and wide characters", () => {
    const { shown, type, press, guided } = setup();
    type("a😀b");
    press("backspace");
    expect(shown.at(-1)).toBe("guide > a😀");
    press("backspace");
    expect(shown.at(-1)).toBe("guide > a");
    press("backspace");
    // An empty line goes away rather than holding the screen.
    expect(shown.at(-1)).toBe("<closed>");
    press("backspace");

    type("again");
    press("u", { ctrl: true });
    expect(shown.at(-1)).toBe("<closed>");
    press("return");
    expect(guided).toEqual([]);
  });

  it("ignores keys that type nothing", () => {
    const { shown, press, input } = setup();
    press("up");
    press("tab");
    input.emit("keypress", "\x01", key("a", { ctrl: true }));
    expect(shown).toEqual([]);
  });

  it("keeps the line when the turn refuses the guidance", () => {
    const { turnInput, shown, type, press } = setup({ onGuide: () => false });
    type("late");
    press("return");
    expect(shown.at(-1)).toBe("guide > late");
    expect(turnInput.detach()).toBe("late");
  });

  it.each(["/help", "!ls"])("does not send %s, and says why", (command) => {
    const { turnInput, shown, guided, type, press } = setup();
    type(command);
    press("return");
    expect(guided).toEqual([]);
    expect(shown.at(-1)).toBe(
      `guide > ${command}  (commands run when the turn ends)`,
    );
    // Editing the line drops the note.
    press("backspace");
    expect(shown.at(-1)).toBe(`guide > ${command.slice(0, -1)}`);
    turnInput.detach();
  });

  it("interrupts on Escape and hands back the unsent line", () => {
    const { turnInput, shown, onInterrupt, type, press } = setup();
    type("half a thought");
    press("escape");
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(shown.at(-1)).toBe("<closed>");
    expect(turnInput.detach()).toBe("half a thought");
    // Detached: later keys do nothing.
    press("escape");
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("puts the line aside for another prompt and brings it back", () => {
    const { turnInput, shown, guided, type, press } = setup();
    type("dra");
    turnInput.suspend();
    expect(shown.at(-1)).toBe("<closed>");
    // The keyboard belongs to the other prompt now.
    type("yyy");
    press("return");
    expect(guided).toEqual([]);

    turnInput.resume();
    expect(shown.at(-1)).toBe("guide > dra");
    type("ft");
    press("return");
    expect(guided).toEqual(["draft"]);
  });

  it("still interrupts on Escape while suspended", () => {
    const { turnInput, onInterrupt, press } = setup();
    turnInput.suspend();
    press("escape");
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("reads only Escape where no line can be shown", () => {
    const { turnInput, guided, onInterrupt, type, press } = setup({}, false);
    type("typed");
    press("return");
    expect(guided).toEqual([]);
    press("escape");
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(turnInput.detach()).toBe("");
  });

  it("takes raw mode for the turn and gives it back", () => {
    const { input, turnInput } = setup();
    expect(input.setRawMode).toHaveBeenCalledWith(true);
    turnInput.detach();
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.pause).toHaveBeenCalled();
  });

  it("does nothing when input is not interactive", () => {
    const input = withKeypressEvents(createTtyInputStream());
    const onInterrupt = jest.fn();
    const turnInput = createTurnInput({
      input,
      interactiveInput: false,
      line: null,
      promptText: "",
      onGuide: () => true,
      onInterrupt,
    });
    turnInput.attach();
    input.emit("keypress", undefined, key("escape"));
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(input.setRawMode).not.toHaveBeenCalled();
    expect(turnInput.detach()).toBe("");
  });
});
