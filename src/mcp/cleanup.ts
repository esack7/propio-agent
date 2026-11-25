import type { ChildProcess } from "node:child_process";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

async function waitBestEffort(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  await new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
    promise.then(
      () => {
        resolve();
      },
      () => {
        resolve();
      },
    );
  });

  if (timeout) {
    clearTimeout(timeout);
  }
}

/** SDK 1.29.0 compatibility shim: capture the original child before close clears it.
 * The public PID/onclose API cannot distinguish exit from inherited-pipe closure.
 * Keep this private-field dependency isolated and covered by real-process tests.
 */
export async function closeClientBestEffort(
  client: Client,
  transport: Transport | undefined,
  timeoutMs: number,
): Promise<void> {
  const child = (
    transport as unknown as { _process?: ChildProcess } | undefined
  )?._process;
  if (transport instanceof StreamableHTTPClientTransport) {
    await waitBestEffort(
      Promise.resolve().then(() => transport.terminateSession()),
      timeoutMs,
    );
  }
  const closing = Promise.resolve().then(() => client.close());
  await waitBestEffort(closing, timeoutMs);
  // A concurrent SDK close can resolve immediately after detaching its transport,
  // while the original close is still waiting for this child to exit.
  if (child?.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* Best-effort cleanup. */
    }
    await waitBestEffort(closing, timeoutMs);
  }
}
