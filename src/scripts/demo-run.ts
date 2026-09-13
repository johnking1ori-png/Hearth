/**
 * End-to-end smoke test: starts the full Hearth stack in-process, then drives
 * the agent through the demo storyline over the real MCP Streamable HTTP surface.
 *
 *   npm run demo
 */
import { config } from "../config/env.js";
import { mcpClient } from "../agent/mcpClient.js";
import { buildAutoProvider } from "../agent/factory.js";
import { runAgentTask } from "../agent/agentLoop.js";

const DEMO_PROMPTS = [
  "Plan next week's dinners. We're vegetarian on Tuesdays and Thursdays — Alex is dairy allergic.",
  "What do we need to buy for the week, given the plan and what's in the pantry?",
  "What's scheduled for tonight and who's cooking? Start a cooking session for it and tell me the first steps.",
  "Start tonight's evening routine so dinner is ready on time.",
];

async function main() {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  console.log(`[demo] starting Hearth stack (provider=${config.llmProvider}, port=${config.port})`);
  await import("../server/index.js");
  await delay(600); // let the server bind

  console.log("[demo] connecting agent to the MCP server (Streamable HTTP)…");
  const tools = await mcpClient.listTools();
  console.log(`[demo] MCP server advertises ${tools.length} tools\n`);

  const provider = buildAutoProvider();
  console.log(`[demo] agent engine: ${provider.model}\n`);

  for (const [i, promptText] of DEMO_PROMPTS.entries()) {
    console.log(`\n──────────────────────────────────────────────────────`);
    console.log(`TURN ${i + 1}: ${promptText}`);
    console.log(`──────────────────────────────────────────────────────\n`);

    const outcome = await runAgentTask({
      request: promptText,
      provider,
      mcp: mcpClient,
      onEvent: (ev) => {
        if (ev.type === "tool_start") console.log(`  ▶ called ${ev.name}(${JSON.stringify(ev.args ?? {})})`);
      },
    });

    console.log(`\n  agent (${outcome.provider}/${outcome.model}, ${outcome.toolCalls} tool calls, ${outcome.durationMs}ms):`);
    console.log(
      outcome.text
        .split("\n")
        .map((l) => "  " + l)
        .join("\n"),
    );
  }

  console.log("\n[demo] smoke test complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[demo] failed:", err);
  process.exit(1);
});