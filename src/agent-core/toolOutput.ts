import type { ToolOutputChunk } from "../tools/execution.js";
import { utf8Tail } from "../tools/display.js";
import type { AgentToolOptions, AgentVisibilityEvent } from "./events.js";

type OutputEvent = Extract<AgentVisibilityEvent, { type: "tool_output" }>;

/** Bounded, per-call telemetry. Final results are collected independently. */
export function createToolOutput(
  callId: string,
  emit: (event: OutputEvent) => void,
) {
  const started = performance.now();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { stream: ToolOutputChunk["stream"]; text: string }[] = [];
  let bytes = 0;
  let droppedBytes = 0;
  const flush = () => {
    timer = undefined;
    const chunks = pending;
    const dropped = droppedBytes;
    pending = [];
    bytes = 0;
    droppedBytes = 0;
    if (closed || chunks.length === 0) return;
    // Adjacent chunks coalesce; at most 32 ordered chunks and 4 KiB per window.
    for (const [i, chunk] of chunks.entries()) {
      try {
        emit({
          type: "tool_output",
          toolCallId: callId,
          ...chunk,
          droppedBytes: i === chunks.length - 1 ? dropped : 0,
          elapsedMs: Math.max(0, performance.now() - started),
          transient: true,
        });
      } catch {
        /* Telemetry consumers cannot change tool execution. */
      }
    }
  };
  const trim = () => {
    while (bytes > 4096 || pending.length > 32) {
      const first = pending[0]!;
      const size = Buffer.byteLength(first.text);
      const tail =
        pending.length > 32
          ? ""
          : utf8Tail(first.text, Math.max(0, size - (bytes - 4096)));
      const removed = size - Buffer.byteLength(tail);
      bytes -= removed;
      droppedBytes += removed;
      if (tail) first.text = tail;
      else pending.shift();
    }
  };
  return {
    append(chunk: ToolOutputChunk) {
      if (closed || !chunk.text) return;
      const kept = utf8Tail(chunk.text, 4096);
      droppedBytes += Buffer.byteLength(chunk.text) - Buffer.byteLength(kept);
      const last = pending[pending.length - 1];
      if (last?.stream === chunk.stream) last.text += kept;
      else pending.push({ ...chunk, text: kept });
      bytes += Buffer.byteLength(kept);
      trim();
      timer ??= setTimeout(flush, 100);
    },
    close(options: { discard?: boolean } = {}) {
      if (timer) clearTimeout(timer);
      if (options.discard) {
        pending = [];
        bytes = 0;
        droppedBytes = 0;
      }
      flush();
      closed = true;
    },
  };
}

export function observeToolOutput(callId: string, options?: AgentToolOptions) {
  const emit = options?.onEvent;
  if (!emit || options?.streamToolOutput === false)
    return { append: undefined, close() {} };
  const output = createToolOutput(callId, (event) => {
    if (!options?.abortSignal?.aborted) emit(event);
  });
  return {
    append: output.append,
    close: () => output.close({ discard: options?.abortSignal?.aborted }),
  };
}
