import type { LLMProvider, CompleteParams, ProviderResult } from "./provider.js";
import { newId, nextMonday, todayLocal } from "../state/store.js";

/**
 * Deterministic "provider" used for offline demos and CI so the agent loop is
 * fully testable even where Amazon Bedrock credentials are not available.
 * It never pretends to be an LLM — it picks tool sequences by intent matching
 * and summarizes results with plain-language templates. Set HEARTH_LLM_PROVIDER=bedrock
 * to use the real Amazon Bedrock route.
 */
export class LocalProvider implements LLMProvider {
  readonly id = "local";
  readonly model = "hearth-intent-router/v1";

  async complete(params: CompleteParams): Promise<ProviderResult> {
    const last = params.messages.at(-1);
    if (!last) return { text: "Hello! I'm Hearth, your household orchestrator.", toolCalls: [], provider: this.id, model: this.model };

    // If this turn already ran tools, summarize the results into a friendly answer.
    if (last.role === "user" && last.toolResults && last.toolResults.length) {
      return { text: summarizeToolResults(last.toolResults), toolCalls: [], provider: this.id, model: this.model };
    }

    const request = last.content.toLowerCase();
    const calls = routeIntent(request);
    if (calls.length) {
      return {
        text: null,
        toolCalls: calls.map((c) => ({ id: newId("tc"), ...c })),
        provider: this.id,
        model: this.model,
        stopReason: "tool_use",
      };
    }

    return { text: defaultAnswer(request), toolCalls: [], provider: this.id, model: this.model };
  }
}

function routeIntent(request: string): { name: string; input: Record<string, unknown> }[] {
  const today = todayLocal();

  if (/(plan|menu|meals?|dinners?|week).*(next week|week|tonight|tuesday|thursday)/.test(request) || /^(plan|menu|prep).*(week|dinner)/.test(request)) {
    const note = request.match(/vegetarian.*(?:tuesday|thursday|tue|thu)/) ? "vegetarian on Tuesdays and Thursdays" : undefined;
    return [{ name: "mealplan.generate", input: { note: note ?? "", weekStart: nextMonday() } }];
  }

  if (/(shopping|grocer|need to (buy|pick)).*(week|meal|plan|dinner)/.test(request)) {
    return [{ name: "shopping.sync_from_mealplan", input: {} }];
  }

  const addMatch = request.match(/add[^,.!]*?(.+?)\s+to the shopping list/);
  if (addMatch?.[1]) {
    return [{ name: "shopping.add", input: { name: addMatch[1].trim(), quantity: 1, unit: "" } }];
  }

  if (/(routine|evening|tonight|wind down|after dinner|tonight's plan)/.test(request) && /(plan|what|start|prepare)/.test(request)) {
    return [{ name: "routine.plan_evening", input: { date: today } }];
  }

  if (/cook|start (the )?dinner|i'?m? hungry|what'?s cooking/.test(request)) {
    return [{ name: "cooking.status", input: {} }];
  }

  if (/pantry|stock|inventory|do we have/.test(request)) {
    return [{ name: "pantry.list", input: {} }];
  }

  if (/shopping|shopping list|to buy|groceries/.test(request)) {
    return [{ name: "shopping.list", input: {} }];
  }

  return [{ name: "household.get_status", input: {} }];
}

function defaultAnswer(request: string): string {
  if (/vegetarian|vegan|diet|preference|allerg/.test(request)) {
    return "I can adapt the weekly meal plan to your household's preferences and allergies. Ask me to \"plan next week's dinners, vegetarian on Tuesdays and Thursdays\", and I'll regenerate the plan and refresh your shopping list.";
  }
  return "I'm Hearth — your household task orchestrator. I manage the meal plan, pantry, shopping list, cooking sessions, and the evening routine. Try: \"plan next week's dinners\", \"what do we need from the store?\", or \"start tonight's evening routine\".";
}

function summarizeToolResults(results: { toolUseId: string; content: string; isError: boolean }[]): string {
  const sections: string[] = [];
  for (const r of results) {
    const body = r.content.length > 900 ? r.content.slice(0, 900) + "…" : r.content;
    sections.push(r.isError ? `⚠️ something went wrong:\n${body}` : body);
  }
  return sections.join("\n\n");
}