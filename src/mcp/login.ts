import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { openSystemBrowser } from "../auth/openai/browser.js";
import { McpAuthorizationError } from "./oauth.js";
import type { McpOAuthInteraction } from "./oauth.js";

/** Listener lifetime includes discovery and exchange, even if the browser never returns. */
export async function withMcpLogin<T>(
  operation: (
    interaction: McpOAuthInteraction,
    signal: AbortSignal,
  ) => Promise<T>,
  openBrowser: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<void> = openSystemBrowser,
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
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400).end("Invalid sign-in callback");
      return;
    }
    const state = url.searchParams.get("state");
    if (url.pathname !== path || !expectedState || state !== expectedState) {
      response.writeHead(400).end("Invalid sign-in callback");
      return;
    }
    const code = url.searchParams.get("code");
    response.end(
      code && !url.searchParams.has("error")
        ? "Sign-in received. Return to Propio."
        : "Sign-in rejected. Return to Propio to retry /mcp login.",
    );
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
        authorize: async (url, authorizationSignal) => {
          expectedState = url.searchParams.get("state");
          let cancel = () => {};
          const cancelled = new Promise<never>((_resolve, reject) => {
            cancel = () =>
              reject(
                new Error("Sign-in cancelled or timed out; retry /mcp login"),
              );
            if (authorizationSignal.aborted) cancel();
            else
              authorizationSignal.addEventListener("abort", cancel, {
                once: true,
              });
          });
          try {
            return await Promise.race([
              callback,
              openBrowser(url.href, authorizationSignal)
                .catch(() => {
                  throw new McpAuthorizationError(
                    "Could not open the sign-in browser; check the system browser and retry /mcp login <server>",
                  );
                })
                .then(() => callback),
              cancelled,
            ]);
          } finally {
            authorizationSignal.removeEventListener("abort", cancel);
          }
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
