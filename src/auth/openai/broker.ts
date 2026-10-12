import { createServer, request as httpRequest } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const descriptorSchema = z.object({
  version: z.literal(1),
  accountId: z.string().uuid(),
  label: z.string(),
  port: z.number().int().min(1).max(65535),
  capability: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BrokerDescriptor = z.infer<typeof descriptorSchema>;

/** Loopback only. Each server has exactly one inference capability and registration. */
export async function startCredentialBroker(options: {
  accountId: string;
  label: string;
  getAccessToken: (signal: AbortSignal) => Promise<string>;
}): Promise<{ descriptor: BrokerDescriptor; close(): Promise<void> }> {
  const capability = randomBytes(32).toString("hex");
  const lifetime = new AbortController();
  const server = createServer(
    { maxHeaderSize: 4096, requestTimeout: 5000 },
    async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json");
      const supplied =
        request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (
        !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(capability))
      ) {
        response.writeHead(401).end('{"error":"unauthorized"}');
        return;
      }
      if (
        request.method !== "GET" ||
        request.url !== "/token" ||
        request.headers["content-length"] ||
        request.headers["transfer-encoding"]
      ) {
        response.writeHead(400).end('{"error":"unsupported_request"}');
        return;
      }
      try {
        const signal = AbortSignal.any([
          lifetime.signal,
          AbortSignal.timeout(15000),
        ]);
        const token = await options.getAccessToken(signal);
        signal.throwIfAborted();
        response.end(JSON.stringify({ accessToken: token }));
      } catch {
        response.writeHead(403).end('{"error":"sign_in_required"}');
      }
    },
  );
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Cannot start subscription credential broker.");
  return {
    descriptor: {
      version: 1,
      accountId: options.accountId,
      label: options.label,
      port: address.port,
      capability,
    },
    close: async () => {
      lifetime.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function readBrokerDescriptor(): Promise<
  BrokerDescriptor | undefined
> {
  const path = process.env.PROPIO_SUBSCRIPTION_BROKER_FILE;
  if (!path) return undefined;
  if (path !== "/run/propio-subscription/broker.json")
    throw new Error("Invalid sandbox credential channel path.");
  try {
    return descriptorSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new Error(
      "Sandbox credential channel is unavailable; restart it from the host wrapper.",
    );
  }
}

export async function getBrokerToken(
  descriptor: BrokerDescriptor,
  accountId: string,
  signal?: AbortSignal,
): Promise<string> {
  if (descriptor.accountId !== accountId)
    throw new Error(
      "This sandbox is scoped to another account. Restart it from the host to change accounts.",
    );
  // Node HTTP avoids caller-controlled proxy environment settings for the private channel.
  return new Promise<string>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "host.docker.internal",
        port: descriptor.port,
        path: "/token",
        method: "GET",
        headers: { Authorization: `Bearer ${descriptor.capability}` },
        signal,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 32768) req.destroy();
        });
        res.on("error", () =>
          reject(new Error("Host credential channel failed.")),
        );
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                "Host sign-in is required; no API fallback was attempted.",
              ),
            );
            return;
          }
          try {
            const data = z
              .object({ accessToken: z.string().min(1) })
              .parse(JSON.parse(body));
            resolve(data.accessToken);
          } catch {
            reject(new Error("Invalid host credential response."));
          }
        });
      },
    );
    req.setTimeout(20000, () => req.destroy());
    req.on("error", () =>
      reject(
        new Error(
          "Host credential channel is unavailable. Restart the sandbox.",
        ),
      ),
    );
    req.end();
  });
}
