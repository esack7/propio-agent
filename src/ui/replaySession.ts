import {
  parseProtocolEvent,
  type ProtocolEvent,
} from "../agent-core/protocol.js";
import type { TerminalUi } from "./terminal.js";
import type { AssistantTurnVisibilitySource } from "./assistantTurnRenderer.js";
import { createTurnEventRenderer } from "./turnEventRenderer.js";

/** Replay complete turns, without running tools or answering approval requests.
 * Approval UI can observe requests through onEvent; replay never authorizes them.
 * Transient output may be omitted: final tool displays carry the retained tails.
 */
export function replaySession(
  values: readonly unknown[],
  ui: TerminalUi,
  visibility: AssistantTurnVisibilitySource,
  options: {
    skipTransient?: boolean;
    onEvent?: (event: ProtocolEvent) => void;
  } = {},
): void {
  const events = validateRecording(values);
  let renderer = createTurnEventRenderer(ui, visibility);
  try {
    for (const envelope of events) {
      const event = envelope.event;
      if (event.type === "session_turn_started") {
        renderer.finish();
        renderer = createTurnEventRenderer(ui, visibility);
      }
      options.onEvent?.(envelope);
      if (options.skipTransient && event.type === "tool_output") continue;
      renderer.accept(event);
      if (event.type === "session_turn_ended") renderer.finish();
    }
  } finally {
    renderer.finish();
  }
}

function validateRecording(values: readonly unknown[]): ProtocolEvent[] {
  const events = values.map(parseProtocolEvent);
  for (let i = 1; i < events.length; i++) {
    if (events[i].seq !== events[i - 1].seq + 1)
      throw new Error("Replay requires contiguous event sequence");
  }
  return events;
}
