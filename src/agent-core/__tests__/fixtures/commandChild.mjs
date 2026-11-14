// Steers a session from another process. It shares nothing with the process
// that runs the turn: events arrive as JSON lines, commands leave the same way.
import readline from "node:readline";

let next = 0;
const send = (command) =>
  process.stdout.write(
    `${JSON.stringify({ commandId: `child-${process.pid}-${++next}`, ...command })}\n`,
  );

send({ type: "submit", text: "Find the records" });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const event = JSON.parse(line);
  if (event.type === "tool_started" && event.args.key === "a") {
    send({ type: "guide", text: "Only the 2024 records." });
  } else if (event.type === "approval_requested") {
    send({
      type: "answer_approval",
      answer: {
        requestId: event.request.id,
        decision: "deny",
        reason: `child ${process.pid} refused ${event.request.toolName}`,
      },
    });
  } else if (event.type === "tool_started" && event.args.key === "b") {
    send({ type: "interrupt" });
  } else if (event.type === "session_turn_ended") {
    if (event.outcome === "cancelled") {
      send({ type: "submit", text: "Carry on" });
    } else {
      process.exit(0);
    }
  }
});
