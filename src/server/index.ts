import express from "express";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import cors from "cors";
import { config, resolveSystemPrompt } from "../config/env.js";
import { HouseholdStore } from "../state/store.js";
import { createHearthMcpServer } from "./tools.js";
import { buildAutoProvider } from "../agent/factory.js";
import { runAgentTask, type AgentEvent } from "../agent/agentLoop.js";
import { mcpClient } from "../agent/mcpClient.js";
import type { ProviderMessage } from "../agent/provider.js";
import { isBedrockConfigured } from "../agent/provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const WEB_DIST = resolve(ROOT, "web/dist");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ── Household store ────────────────────────────────────────────────────────
const store = new HouseholdStore(config.stateFile);
console.log(`[hearth] household: ${store.getState().householdName} — ${store.getState().family.length} members`);

// ── MCP server ─────────────────────────────────────────────────────────────
// A fresh McpServer is created per HTTP session and layered over the shared
// household store, so many MCP clients can drive the same household at once.
// The SDK's McpServer.connect() only allows one transport at a time.
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let session = sessionId ? sessions.get(sessionId) : undefined;
  const isInit = !session;

  if (isInit) {
    let transport!: StreamableHTTPServerTransport;
    const server = createHearthMcpServer(store);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        console.log(`[hearth] MCP session ${sid} initialized`);
        sessions.set(sid, { transport, server });
      },
      onsessionclosed: (sid) => {
        console.log(`[hearth] MCP session ${sid} closed`);
        sessions.delete(sid);
      },
    });
    await server.connect(transport);
    session = { transport, server };
  }

  await session!.transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(404).json({ error: "No MCP session" });
    return;
  }
  await session.transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(404).json({ error: "No MCP session" });
    return;
  }
  await session.transport.handleRequest(req, res);
  sessions.delete(sessionId!);
});

// ── REST API ───────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    household: store.getState().householdName,
    bedrock: isBedrockConfigured(),
    model: config.bedrockModel,
    mcpSessions: sessions.size,
    dinnerTime: config.dinnerTime,
  });
});

app.get("/api/household", (_req, res) => {
  res.json(store.getState());
});

app.post("/api/reset", (_req, res) => {
  store.resetToSeed();
  res.json({ status: "reset", household: store.getState() });
});

// ── Agent chat (SSE) ──────────────────────────────────────────────────────
const sessionHistory = new Map<string, ProviderMessage[]>();
const MAX_HISTORY = 40;

app.post("/v1/chat", async (req, res) => {
  const { message, sessionId: sid } = req.body as { message?: string; sessionId?: string };
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message required" });
    return;
  }
  const sessionId = sid ?? "default";
  const history = sessionHistory.get(sessionId) ?? [];

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sendEvent = (ev: AgentEvent) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  try {
    const provider = buildAutoProvider();
    const outcome = await runAgentTask({
      request: message,
      provider,
      mcp: mcpClient,
      history: [...history],
      onEvent: sendEvent,
      system: resolveSystemPrompt(),
    });

    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: outcome.text });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    sessionHistory.set(sessionId, history);

    res.write(
      `data: ${JSON.stringify({
        type: "done",
        content: outcome.text,
        provider: outcome.provider,
        model: outcome.model,
        durationMs: outcome.durationMs,
        iterations: outcome.iterations,
        toolCalls: outcome.toolCalls,
      })}\n\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[hearth] chat error:", msg);
    res.write(`data: ${JSON.stringify({ type: "error", content: msg })}\n\n`);
  }

  res.end();
});

// ── Static files (SPA) ─────────────────────────────────────────────────────
if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(resolve(WEB_DIST, "index.html"));
  });
}

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`[hearth] MCP server: http://127.0.0.1:${config.port}/mcp`);
  console.log(`[hearth] API:        http://127.0.0.1:${config.port}/api/household`);
  console.log(`[hearth] Chat (SSE): http://127.0.0.1:${config.port}/v1/chat`);
  console.log(`[hearth] Provider:   ${config.llmProvider} — Bedrock available: ${isBedrockConfigured()}`);
});