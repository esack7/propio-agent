// Runs a bash tool call that starts a child ignoring SIGTERM and SIGINT, then
// leaves the way the CLI does. The test checks that the child does not
// outlive this process.
import { BashTool } from "../../../tools/bash.ts";
import { createAbortStateController } from "../../../ui/abortState.ts";
import { exitAfterShellCleanup } from "../../exit.ts";

const [mode, pidFile] = process.argv.slice(2);

// "graceful": the child takes a moment to clean up on SIGTERM, then records
// that it finished. Otherwise it ignores SIGTERM and SIGINT.
const onTerm =
  mode === "graceful"
    ? `process.on("SIGTERM", () => setTimeout(() => {
         require("fs").writeFileSync(${JSON.stringify(`${pidFile}.cleaned`)}, "yes");
         process.exit(0);
       }, 300));`
    : `process.on("SIGTERM", () => {});`;
const stubbornChild = `'${process.execPath}' -e '
  ${onTerm}
  process.on("SIGINT", () => {});
  require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
' >/dev/null 2>&1 & wait`;

const ui = { warn() {}, setMode() {} };
const abortState = createAbortStateController(ui);
const controller = new AbortController();
abortState.setCurrentAbortController(controller);

// Not awaited: on abort the runtime stops waiting for the tool, as here.
void new BashTool()
  .executeWithStatus({ command: stubbornChild }, { signal: controller.signal })
  .catch(() => {});

if (mode === "sigint" || mode === "graceful") {
  // The CLI's own sequence: the handler aborts the turn, main returns 130,
  // and the entrypoint exits.
  process.once("SIGINT", () => {
    abortState.handleSigint();
    void exitAfterShellCleanup(130);
  });
} else if (mode === "exit") {
  // An exit that skips the drain, such as a direct process.exit.
  process.once("SIGUSR2", () => process.exit(1));
}
process.stdout.write("ready\n");
