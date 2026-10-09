/**
 * CLI REPL for a running Hearth server: talk to the agent over /v1/chat (SSE)
 * and watch the MCP tool trace as it works.
 *
 *   npm run agent                       # http://127.0.0.1:4000
 *   HEARTH_AGENT_URL=http://host:4000 npm run agent
 */
import { createInterface } from "node:readline/promises";
import { config } from "../config/env.js";

const base = (process.env.HEARTH_AGENT_URL ?? `http://127.0.0.1:${config.port}`).replace(/\/$/, "");
const sessionId = `cli-${process.pid}`;

interface StreamEvent {
  type: string;
  name?: string;
  args?: Record<string, unknown>;
  content?: string;
  provider?: string;
  iterations?: number;
  durationMs?: number;
}

async function ask(question: string): Promise<void> {
  const res = await fetch(`${base}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: question, sessionId }),
  });
  if (!res.ok || !res.body) {
    console.error(`  ! chat failed (${res.status}) — is the server running? (npm run dev)`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      const ev = JSON.parse(part.slice(6)) as StreamEvent;
      if (ev.type === "tool_start") {
        const args = ev.args && Object.keys(ev.args).length ? ` ${JSON.stringify(ev.args)}` : "";
        console.log(`  > ${ev.name}${args}`);
      } else if (ev.type === "tool_result") {
        const first = String(ev.content ?? "").split("\n")[0] ?? "";
        console.log(`      ${first.slice(0, 110)}${first.length > 110 ? "…" : ""}`);
      } else if (ev.type === "error") {
        console.error(`  ! ${ev.content}`);
      } else if (ev.type === "done") {
        console.log(`\n${ev.content ?? ""}`);
        console.log(`  [${ev.provider} · ${ev.iterations} iterations · ${ev.durationMs}ms]\n`);
      }
    }
  }
}

async function main() {
  console.log(`Hearth CLI agent — ${base}/v1/chat  (type "exit" to quit)`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const line = (await rl.question("\nyou> ")).trim();
    if (!line) continue;
    if (/^(exit|quit|q)$/i.test(line)) break;
    await ask(line);
  }
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
