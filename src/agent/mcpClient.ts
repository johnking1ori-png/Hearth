import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config/env.js";

export interface HearthMCPClient {
  connect(): Promise<void>;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
  close(): Promise<void>;
}

/**
 * The Hearth agent talks to the Hearth MCP server over the real Streamable
 * HTTP transport — the same MCP surface Alexa+ or any MCP client would use.
 * This keeps the orchestration layer honest: it only holds the tools the
 * server advertises, exactly like a skill running on Alexa+.
 */
export function createMCPClient(baseUrl: string): HearthMCPClient {
  let client: Client | null = null;
  let transport: StreamableHTTPClientTransport | null = null;
  const url = new URL(baseUrl);

  async function connect(): Promise<void> {
    if (client) return;
    transport = new StreamableHTTPClientTransport(url);
    client = new Client({ name: "hearth-agent", version: "1.0.0" });
    await client.connect(transport);
  }

  async function listTools(): Promise<Tool[]> {
    await connect();
    const res = await client!.listTools();
    return res.tools;
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    await connect();
    const res = await client!.callTool({ name, arguments: args });
    const parts: string[] = [];
    for (const item of (res.content as unknown as { type?: string; text?: string; uri?: string }[] | undefined) ?? []) {
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (item.type === "resource" && typeof item.uri === "string") parts.push(item.uri);
      else if (typeof item.text === "string") parts.push(item.text);
    }
    return { content: parts.join("\n") || "(no output)", isError: res.isError === true };
  }

  return {
    connect,
    listTools,
    callTool,
    async close() {
      await client?.close();
      await transport?.close();
      client = null;
      transport = null;
    },
  };
}

export const mcpClient = createMCPClient(`http://127.0.0.1:${config.port}/mcp`);