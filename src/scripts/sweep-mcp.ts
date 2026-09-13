/**
 * Concurrency sweep: open TWO MCP sessions against one running Hearth server
 * and list tools on both. Verifies the per-session McpServer design.
 * Usage: npx tsx src/scripts/sweep-mcp.ts [port=4600]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const port = Number(process.argv[2] ?? 4600);
const url = `http://127.0.0.1:${port}/mcp`;

async function open(name: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { name, toolCount: tools.length };
}

const sessions = await Promise.all([open("sweep-a"), open("sweep-b")]);
for (const s of sessions) {
  console.log(`[sweep] ${s.name}: ${s.toolCount} tools listed concurrently`);
}
process.exit(0);