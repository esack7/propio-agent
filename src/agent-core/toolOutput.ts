import type { ToolOutputChunk } from "../tools/execution.js";
import { utf8Head } from "../tools/display.js";
import type { AgentVisibilityEvent } from "./events.js";

type OutputEvent = Extract<AgentVisibilityEvent, { type: "tool_output" }>;

/** Bounded, per-call telemetry. Final results are collected independently. */
export function createToolOutput(
  callId: string,
  emit: (event: OutputEvent) => void,
) {
  const started = performance.now();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: ToolOutputChunk[] = [];
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
    // A window may contain both streams; its combined text is capped at 4 KiB.
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
  return {
    append(chunk: ToolOutputChunk) {
      if (closed || !chunk.text) return;
      const kept = utf8Head(chunk.text, Math.max(0, 4096 - bytes));
      const size = Buffer.byteLength(kept);
      droppedBytes += Buffer.byteLength(chunk.text) - size;
      bytes += size;
      if (kept) {
        const index = pending.findIndex(
          (entry) => entry.stream === chunk.stream,
        );
        if (index >= 0)
          pending[index] = { ...chunk, text: pending[index]!.text + kept };
        else pending.push({ ...chunk, text: kept });
      }
      timer ??= setTimeout(flush, 100);
    },
    close() {
      if (timer) clearTimeout(timer);
      flush();
      closed = true;
    },
  };
}
