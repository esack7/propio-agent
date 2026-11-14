/**
 * A terminal stream whose output can be held back for a moment and then
 * released in order. While something else needs the screen, everything the
 * rest of the UI writes is kept, not lost, and appears when the hold ends.
 */
export interface HoldableStream {
  /** Use this in place of the stream it wraps. */
  readonly stream: NodeJS.WriteStream;
  readonly held: boolean;
  /** Start holding output. Returns null if a hold is already in place. */
  hold(): OutputHold | null;
}

export interface OutputHold {
  /** Write past the hold, straight to the terminal. */
  write(text: string): void;
  /** End the hold and write everything that was held, in order. */
  release(): void;
}

/**
 * Terminal methods that produce output by calling `this.write`. Called on
 * the wrapped stream they would skip the hold, so they run against the
 * wrapper instead.
 */
const WRITING_METHODS: ReadonlySet<PropertyKey> = new Set([
  "cursorTo",
  "moveCursor",
  "clearLine",
  "clearScreenDown",
]);

export function createHoldableStream(
  target: NodeJS.WriteStream,
): HoldableStream {
  type Write = (...args: unknown[]) => boolean;
  const rawWrite = target.write as Write;
  let pending: Array<{ chunk: unknown; encoding: unknown }> | null = null;

  // The hold sits at the bottom, on the way out to the terminal. Other code
  // may install its own write on top (a spinner does while it is on screen)
  // and that write ends up here, so a hold keeps exactly the bytes the
  // terminal would have received, in the order it would have received them.
  const gatedWrite: Write = (chunk, encodingOrCallback, callback) => {
    if (pending === null) {
      return rawWrite.call(target, chunk, encodingOrCallback, callback);
    }
    const encoding =
      typeof encodingOrCallback === "function" ? undefined : encodingOrCallback;
    pending.push({ chunk, encoding });
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (typeof done === "function") (done as () => void)();
    return true;
  };

  // Whatever write was last installed. Reading `write` returns exactly what
  // was assigned, so code that checks whether its own write is still in
  // place before putting the previous one back finds it there.
  let current: Write = gatedWrite;

  const stream = new Proxy(target, {
    get(wrapped, property, receiver) {
      if (property === "write") return current;
      const value = Reflect.get(wrapped, property, wrapped) as unknown;
      if (typeof value !== "function") return value;
      return (value as (...args: unknown[]) => unknown).bind(
        WRITING_METHODS.has(property) ? receiver : wrapped,
      );
    },
    set(wrapped, property, value) {
      if (property !== "write") return Reflect.set(wrapped, property, value);
      current = value as Write;
      return true;
    },
  });

  return {
    stream,
    get held() {
      return pending !== null;
    },
    hold() {
      if (pending !== null) return null;
      pending = [];
      let released = false;
      return {
        write: (text) => {
          rawWrite.call(target, text);
        },
        release: () => {
          if (released) return;
          released = true;
          const chunks = pending ?? [];
          pending = null;
          for (const { chunk, encoding } of chunks) {
            if (encoding === undefined) rawWrite.call(target, chunk);
            else rawWrite.call(target, chunk, encoding);
          }
        },
      };
    },
  };
}
