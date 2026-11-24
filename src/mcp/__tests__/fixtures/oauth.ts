import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
export async function oauthFixture() {
  let origin = "";
  let disposal: (() => Promise<void>) | undefined;
  let refreshes = 0;
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const registrations = new Map<string, string[]>();
  const tokens = new Set<string>();
  const refreshTokens = new Map<string, string>();
  const tokenOwners = new Map<string, string>();
  const sessionOwners = new Map<string, string>();
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const issueTokens = async (req: IncomingMessage) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const params = new URLSearchParams(body);
    if (
      params.get("grant_type") === "authorization_code" &&
      !registrations
        .get(params.get("client_id")!)
        ?.includes(params.get("redirect_uri")!)
    )
      throw new Error("Callback does not match registered redirect URI");
    const previous = params.get("refresh_token");
    const owner = previous ? refreshTokens.get(previous) : randomUUID();
    if (!owner) throw new Error("Invalid or reused fixture refresh token");
    if (params.get("grant_type") === "refresh_token") {
      refreshTokens.delete(previous!);
      refreshes++;
      started?.();
      if (started)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    }
    const access_token = randomUUID();
    tokens.add(access_token);
    tokenOwners.set(access_token, owner);
    const refresh_token = randomUUID();
    refreshTokens.set(refresh_token, owner);
    return { access_token, token_type: "Bearer", refresh_token };
  };
  const oauthRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const json = (value: unknown) =>
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      return true;
    }
    if (req.url === "/.well-known/oauth-authorization-server") {
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
      return true;
    }
    if (req.url === "/register") {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const metadata = JSON.parse(body);
      const client_id = randomUUID();
      registrations.set(client_id, metadata.redirect_uris);
      json({ ...metadata, client_id });
      return true;
    }
    if (req.url === "/token") {
      json(await issueTokens(req));
      return true;
    }
    return false;
  };
  const server = createServer(async (req, res) => {
    if (await oauthRequest(req, res)) return;
    const token = req.headers.authorization?.slice(7);
    if (!token || !tokens.has(token)) {
      res
        .writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        })
        .end();
      return;
    }
    const id = req.headers["mcp-session-id"];
    if (typeof id === "string" && sessions.has(id)) {
      if (sessionOwners.get(id) !== tokenOwners.get(token)) {
        res.writeHead(403).end();
        return;
      }
      if (req.method === "DELETE") await disposal?.();
      await sessions.get(id)!.handleRequest(req, res);
      return;
    }
    const remote = new McpServer({ name: "protected", version: "1" });
    remote.registerTool("who", {}, async () => ({
      content: [{ type: "text", text: tokenOwners.get(token)! }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
        sessionOwners.set(id, tokenOwners.get(token)!);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    await remote.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    tokens,
    sessions,
    holdDisposal: (hold: () => Promise<void>) => {
      disposal = hold;
    },
    refreshes: () => refreshes,
    pause: () =>
      new Promise<void>((resolve) => {
        started = resolve;
      }),
    resume: () => {
      started = undefined;
      release?.();
    },
    close: async () => {
      await Promise.all([...sessions.values()].map((s) => s.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
