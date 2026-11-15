// Run after npm run build. No credentials, provider, filesystem tools or terminal.
import {
  AgentSession,
  InMemorySessionEventLog,
  parseProtocolEvent,
} from "@propio-ai/agent/agent-core";

const eventLog = new InMemorySessionEventLog();
const session = new AgentSession({
  eventLog,
  async runTurn(submission, control) {
    const delta = `Hello, ${submission.text}.`;
    control.emit({ type: "assistant_text", delta });
    return delta;
  },
});
session.subscribeProtocol((event) => console.log(JSON.stringify(event)));
session.dispatch({ type: "submit", commandId: "hello", text: "world" });
await session.settled();
// A client reconnecting after event 1 gets the remaining events, in order.
const decoded = JSON.parse(JSON.stringify(eventLog.after(1)));
for (const value of decoded) {
  const event = parseProtocolEvent(value);
  if (event.event.type === "assistant_text")
    console.log(`Replayed #${event.seq}: ${event.event.delta}`);
}
