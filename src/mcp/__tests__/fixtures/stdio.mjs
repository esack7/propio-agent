import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "legacy", version: "1" });
server.registerTool("echo", {}, async () => ({
  content: [{ type: "text", text: "stdio" }],
}));
await server.connect(new StdioServerTransport());
