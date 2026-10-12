import { createServer } from "node:http";

interface CallbackResult {
  code: string;
  clientId: string;
}

function callbackRegistration(
  callback: URL,
  savedClient?: string,
): CallbackResult | undefined {
  const code = callback.searchParams.get("code");
  const returnedClient = callback.searchParams.get("client_id");
  const clientId = returnedClient ?? savedClient;
  if (!code || !clientId || clientId === "dynamic_agent_client")
    return undefined;
  if (savedClient && returnedClient && returnedClient !== savedClient)
    return undefined;
  return { code, clientId };
}

export async function startChatGptCallback(options: {
  state: string;
  clientId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{
  redirectUri: string;
  result: Promise<CallbackResult>;
  close: () => void;
}> {
  let resolve!: (value: CallbackResult) => void;
  let reject!: (error: Error) => void;
  let settled = false;
  const result = new Promise<CallbackResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A cancellation can occur while the browser opener is still starting.
  void result.catch(() => {});
  const fail = (message: string) => {
    if (!settled) {
      settled = true;
      reject(new Error(message));
    }
  };
  const server = createServer((request, response) => {
    const callback = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET" || callback.pathname !== "/auth/callback") {
      response.writeHead(404).end("Not found.");
      return;
    }
    if (settled || callback.searchParams.get("state") !== options.state) {
      response
        .writeHead(400)
        .end("This callback does not match the pending sign-in.");
      return;
    }
    if (callback.searchParams.has("error")) {
      response
        .writeHead(400)
        .end("Sign-in was declined. Return to your terminal.");
      fail("ChatGPT authorization was declined. No inference was attempted.");
      return;
    }
    const registration = callbackRegistration(callback, options.clientId);
    if (!registration) {
      response
        .writeHead(400)
        .end(
          "Sign-in returned an invalid registration. Return to your terminal.",
        );
      fail("ChatGPT returned an invalid or different client registration.");
      return;
    }
    settled = true;
    response.end(
      "Continue in your terminal while Propio verifies your ChatGPT sign-in.",
    );
    resolve(registration);
  });
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", no);
      yes();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start sign-in callback.");
  const timer = setTimeout(
    () => fail("ChatGPT sign-in timed out. Run login again."),
    options.timeoutMs ?? 180000,
  );
  const abort = () => fail("ChatGPT sign-in was cancelled.");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const close = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    fail("ChatGPT sign-in was cancelled.");
    server.close();
    server.closeAllConnections();
  };
  return {
    redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
    result,
    close,
  };
}
