import { McpConnectionManager } from "@propio-ai/agent/mcp";

// Optional: node examples/mcp-consumer.mjs <stdio-command> [arguments...]
const [command, ...args] = process.argv.slice(2);
const manager = new McpConnectionManager({
  config: { mcpServers: command ? { supplied: { command, args } } : {} },
  clientIdentity: { name: "mcp-catalog-consumer", version: "1.0.0" },
  connectTimeoutMs: 10_000,
});
try {
  await manager.initialize();
  console.log(
    JSON.stringify(
      { servers: manager.getServerSummaries(), tools: manager.listTools() },
      null,
      2,
    ),
  );
} finally {
  await manager.close();
}
