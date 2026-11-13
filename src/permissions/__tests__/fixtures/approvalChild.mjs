// Answers approval requests from another process. It shares nothing with the
// process that raised them: one JSON request per line in, one answer out.
import readline from "node:readline";

const decision = process.argv[2] ?? "allow_once";

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const answer =
    decision === "allow_session"
      ? {
          requestId: request.id,
          decision,
          rule: request.suggestions.find((s) => s.scope === "tool").rule,
        }
      : decision === "deny"
        ? {
            requestId: request.id,
            decision,
            reason: `child ${process.pid} refused ${request.toolName}`,
          }
        : { requestId: request.id, decision };
  process.stdout.write(`${JSON.stringify(answer)}\n`);
});
