import type { ChildProcess } from "node:child_process";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function waitBestEffort(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let completed = false;

  await new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
    promise.then(
      () => {
        completed = true;
        resolve();
      },
      () => {
        completed = true;
        resolve();
      },
    );
  });

  if (timeout) {
    clearTimeout(timeout);
  }

  return completed;
}

/** SDK 1.29.0 compatibility shim: capture the original child before close clears it.
 * The public PID/onclose API cannot distinguish exit from inherited-pipe closure.
 * Keep this private-field dependency isolated and covered by real-process tests.
 */
export async function closeClientBestEffort(
  client: Client,
  transport: StdioClientTransport | undefined,
  timeoutMs: number,
): Promise<void> {
  const child = (
    transport as unknown as { _process?: ChildProcess } | undefined
  )?._process;
  const closing = Promise.resolve().then(() => client.close());
  const completed = await waitBestEffort(closing, timeoutMs);
  if (!completed && child?.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* Best-effort cleanup. */
    }
    await waitBestEffort(closing, timeoutMs);
  }
}
