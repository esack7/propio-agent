import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "fake-server", version: "1.0.0" });
server.registerTool("echo", { description: "Echo tool", inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: "text", text: `echo:${message}` }] }));
await server.connect(new StdioServerTransport());