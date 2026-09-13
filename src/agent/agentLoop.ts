import type { LLMProvider, ProviderMessage, ToolResultMessage } from "./provider.js";
import { toBedrockToolSchema } from "./provider.js";
import type { HearthMCPClient } from "./mcpClient.js";

export interface AgentEvent {
  type: "tool_start" | "tool_result" | "assistant";
  name?: string;
  args?: Record<string, unknown>;
  content?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface AgentOutcome {
  text: string;
  provider: string;
  model: string;
  events: AgentEvent[];
  toolCalls: number;
  iterations: number;
  durationMs: number;
}

const SYSTEM_PROMPT = `You are Hearth, an agentic household task orchestrator running inside an MCP server for Alexa+.

You help one household run its evenings: weekly meal planning, pantry awareness, shopping-list management, step-by-step cooking sessions, and a complete evening routine plan that times everything to be ready at dinner time.

Ground every answer in the real household state by calling the MCP tools provided to you. Prefer multi-step workflows over single lookups:
- "Plan our week" = check what's planned, generate a meal plan respecting preferences/allergies, then sync the shopping list.
- "What's for dinner / what do I need" = read the meal plan, then diff against pantry.
- "Start the evening" = plan the evening routine anchored to the dish scheduled for tonight.
When you're asked a question, use household.get_status and/or the specific list tool before answering so your answer reflects reality.
Never invent pantry items, dishes, or times. After completing the workflow, write a concise, friendly summary with the concrete outcomes (meal plan, items to buy, routine times, next steps). Do not mention that you are a deterministic fallback.`;

const MAX_ITERATIONS = 6;

export async function runAgentTask(opts: {
  request: string;
  provider: LLMProvider;
  mcp: HearthMCPClient;
  history?: ProviderMessage[];
  onEvent?: (event: AgentEvent) => void;
  system?: string;
}): Promise<AgentOutcome> {
  const { request, provider, mcp, onEvent } = opts;
  const started = Date.now();
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent) => {
    events.push(e);
    onEvent?.(e);
  };

  // Real MCP server tool listing — the agent only sees what the server advertises.
  const rawTools = await mcp.listTools().catch(() => []);
  const system = opts.system ?? SYSTEM_PROMPT;
  const messages: ProviderMessage[] = [...(opts.history ?? [])];
  messages.push({ role: "user", content: request });

  let iterations = 0;
  let totalToolCalls = 0;

  for (;;) {
    if (++iterations > MAX_ITERATIONS) break;

    const tools = rawTools
      .filter((t) => t.name !== "orchestrate.task") // never recurse into itself
      .map((t) => ({
        name: t.name,
        description: t.description ?? "",
        schema: toBedrockToolSchema(t.inputSchema as unknown as Record<string, unknown>),
      }));

    const result = await provider.complete({ system, messages, tools });
    if (!result.toolCalls.length) {
      const text = result.text ?? "Done.";
      emit({ type: "assistant", content: text });
      return {
        text,
        provider: result.provider,
        model: result.model,
        events,
        toolCalls: totalToolCalls,
        iterations,
        durationMs: Date.now() - started,
      };
    }

    const toolResults: ToolResultMessage[] = [];
    for (const call of result.toolCalls) {
      totalToolCalls += 1;
      const t0 = Date.now();
      emit({ type: "tool_start", name: call.name, args: call.input });
      let content = "(no output)";
      let isError = false;
      try {
        const res = await mcp.callTool(call.name, call.input ?? {});
        content = res.content;
        isError = res.isError;
      } catch (err) {
        isError = true;
        content = err instanceof Error ? err.message : String(err);
      }
      emit({ type: "tool_result", name: call.name, content, isError, durationMs: Date.now() - t0 });
      toolResults.push({ toolUseId: call.id, content, isError });
    }

    messages.push({ role: "assistant", content: result.text ?? "", toolCalls: result.toolCalls });
    messages.push({ role: "user", content: "", toolResults });

    if (toolResults.every((r) => r.isError)) {
      emit({
        type: "assistant",
        content: "I ran into an error while trying to reach the household tools. Please try again.",
      });
      return {
        text: "I ran into an error while trying to reach the household tools.",
        provider: result.provider,
        model: result.model,
        events,
        toolCalls: totalToolCalls,
        iterations,
        durationMs: Date.now() - started,
      };
    }
  }

  emit({ type: "assistant", content: "I hit my iteration limit. Ask me one focused task at a time." });
  return {
    text: "I hit my iteration limit. Ask me one focused task at a time.",
    provider: provider.id,
    model: provider.model,
    events,
    toolCalls: totalToolCalls,
    iterations,
    durationMs: Date.now() - started,
  };
}