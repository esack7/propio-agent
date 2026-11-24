import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { openSystemBrowser } from "../auth/openai/browser.js";
import type { McpOAuthInteraction } from "./oauth.js";

/** Listener lifetime includes discovery and exchange, even if the browser never returns. */
export async function withMcpLogin<T>(
  operation: (
    interaction: McpOAuthInteraction,
    signal: AbortSignal,
  ) => Promise<T>,
  openBrowser: (url: string) => Promise<void> = openSystemBrowser,
  signal: AbortSignal = AbortSignal.timeout(300_000),
): Promise<T> {
  const path = `/callback/${randomUUID()}`;
  let expectedState: string | null = null;
  let complete: ((value: { code: string; state: string }) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const callback = new Promise<{ code: string; state: string }>(
    (resolve, reject) => {
      complete = resolve;
      fail = reject;
    },
  );
  // Cancellation may precede authorize().
  void callback.catch(() => {});
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const state = url.searchParams.get("state");
    if (url.pathname !== path || !expectedState || state !== expectedState) {
      response.writeHead(400).end("Invalid sign-in callback");
      return;
    }
    const code = url.searchParams.get("code");
    response.end("Sign-in received. Return to Propio.");
    if (code && !url.searchParams.has("error")) complete!({ code, state });
    else fail!(new Error("Sign-in rejected; retry /mcp login"));
  });
  const abort = () =>
    fail!(new Error("Sign-in cancelled or timed out; retry /mcp login"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as import("node:net").AddressInfo;
    return await operation(
      {
        redirectUrl: `http://127.0.0.1:${address.port}${path}`,
        authorize: async (url) => {
          expectedState = url.searchParams.get("state");
          await openBrowser(url.href);
          return callback;
        },
      },
      signal,
    );
  } finally {
    signal.removeEventListener("abort", abort);
    server.close();
    server.closeAllConnections();
  }
}
