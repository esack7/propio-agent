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

export function createHoldableStream(
  target: NodeJS.WriteStream,
): HoldableStream {
  type Write = (...args: unknown[]) => boolean;
  // Each held chunk remembers the write it was headed for, so a spinner's
  // own frames are not replayed through the spinner's hook.
  let pending: Array<{ write: Write; chunk: unknown }> | null = null;

  // The stream's own write, which other code may replace: a spinner hooks
  // it while it is on screen and puts it back afterwards. The wrapper must
  // look like the real stream to that code, so it tracks the replacement
  // and hands out a gate over whichever write is current.
  const rawWrite = target.write as Write;
  let current = rawWrite;
  const inner = new WeakMap<Write, Write>();

  const gate = (write: Write): Write => {
    const gated: Write = (chunk, encodingOrCallback, callback) => {
      if (pending === null) {
        return write.call(target, chunk, encodingOrCallback, callback);
      }
      pending.push({ write, chunk });
      const done =
        typeof encodingOrCallback === "function"
          ? encodingOrCallback
          : callback;
      if (typeof done === "function") (done as () => void)();
      return true;
    };
    inner.set(gated, write);
    return gated;
  };

  const stream = new Proxy(target, {
    get(wrapped, property) {
      if (property === "write") return gate(current);
      const value = Reflect.get(wrapped, property, wrapped) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(wrapped)
        : value;
    },
    set(wrapped, property, value) {
      if (property !== "write") return Reflect.set(wrapped, property, value);
      // Putting back a write that was read from here must not stack gates.
      current = inner.get(value as Write) ?? (value as Write);
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
          for (const { write, chunk } of chunks) write.call(target, chunk);
        },
      };
    },
  };
}
