import type {
  LLMProvider,
  CompleteParams,
  ProviderResult,
  ProviderMessage,
  ToolResultMessage,
  ModelToolCall,
} from "./provider.js";
import { newId, nextMonday, thisMonday, todayLocal } from "../state/store.js";

/**
 * Deterministic "provider" used for offline demos and CI so the agent loop is
 * fully testable even where Amazon Bedrock credentials are not available.
 * It never pretends to be an LLM — it picks tool sequences by intent matching
 * and summarizes results with plain-language templates. Set HEARTH_LLM_PROVIDER=bedrock
 * to use the real Amazon Bedrock route.
 *
 * One request can span several tool rounds: after each round the loop calls
 * back into complete(), and nextStep() decides whether another tool is needed
 * (e.g. mealplan.list -> cooking.start) before the answer is summarized.
 */

interface Call {
  name: string;
  input: Record<string, unknown>;
}

const call = (name: string, input: Record<string, unknown> = {}): Call => ({ name, input });
const toModelCall = (c: Call): ModelToolCall => ({ id: newId("tc"), name: c.name, input: c.input });

export class LocalProvider implements LLMProvider {
  readonly id = "local";
  readonly model = "hearth-intent-router/v1";

  async complete(params: CompleteParams): Promise<ProviderResult> {
    const last = params.messages.at(-1);
    if (!last) {
      return { text: "Hello! I'm Hearth, your household orchestrator.", toolCalls: [], provider: this.id, model: this.model };
    }

    const request = currentRequest(params.messages);

    // This round already ran tools: chain the next tool, or summarize the results.
    if (last.role === "user" && last.toolResults && last.toolResults.length) {
      const followUps = nextStep(request, toolsUsed(params.messages), toolOutputs(params.messages));
      if (followUps.length) {
        return { text: null, toolCalls: followUps.map(toModelCall), provider: this.id, model: this.model, stopReason: "tool_use" };
      }
      return { text: summarize(request, last.toolResults, toolsUsed(params.messages)), toolCalls: [], provider: this.id, model: this.model };
    }

    const calls = routeIntent(request.toLowerCase());
    if (!calls.length) {
      const loose = bestEffort(request.toLowerCase());
      if (!loose.length) {
        return { text: defaultAnswer(request.toLowerCase()), toolCalls: [], provider: this.id, model: this.model };
      }
      return { text: null, toolCalls: loose.map(toModelCall), provider: this.id, model: this.model, stopReason: "tool_use" };
    }
    return { text: null, toolCalls: calls.map(toModelCall), provider: this.id, model: this.model, stopReason: "tool_use" };
  }
}

// ── conversation helpers ───────────────────────────────────────────────────

/** The current turn's request: the last user message that actually says something. */
function currentRequest(messages: ProviderMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && m.content.trim()) return m.content;
  }
  return "";
}

/** Tool names already called this turn (only in-turn assistant messages carry toolCalls). */
function toolsUsed(messages: ProviderMessage[]): Set<string> {
  const used = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const tc of m.toolCalls ?? []) used.add(tc.name);
  }
  return used;
}

/** tool name -> result text, for the current turn. */
function toolOutputs(messages: ProviderMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "assistant" || !m.toolCalls?.length) continue;
    const next = messages[i + 1];
    if (!next?.toolResults?.length) continue;
    const byId = new Map(next.toolResults.map((r) => [r.toolUseId, r]));
    for (const tc of m.toolCalls) {
      const r = byId.get(tc.id);
      if (r) out.set(tc.name, r.content);
    }
  }
  return out;
}

// ── intent matching ────────────────────────────────────────────────────────

function isRoutineRequest(req: string): boolean {
  return (
    /\b(routine|evening|wind (me |us )?down|bedtime|for bed|tonight'?s plan)\b/.test(req) &&
    /\b(plan|start|prepare|schedule|build|lay out|arrange|give me|make|create|organize|sort out|walk me through|show|wind)\b/.test(req)
  );
}

function isWhoCooking(req: string): boolean {
  return (
    /\b(who|whose|whomever|whoever)\b/.test(req) &&
    /\b(cook(ing)?|chef|duty|kitchen|making dinner|on for dinner|dinner duty)\b/.test(req) &&
    !/\bstart\b/.test(req)
  );
}

function wantsCookStart(req: string): boolean {
  if (isWhoCooking(req)) return false;
  if (/\b(advance|next step|continue)\b/.test(req)) return false;
  if (/\b(hungry|feed us|food now|dinner please|let'?s eat)\b/.test(req)) return true;
  if (/^(start|begin|go|cook|fire up|let'?s)\b/.test(req) && !/\b(routine|shopping|list|week|pantry|plan)\b/.test(req)) return true;
  return /\b(start|begin|kick off|fire up|get going)\b/.test(req) && /\b(cook|cooking|dinner|meal|recipe)\b/.test(req);
}

function wantsMealPlan(req: string): boolean {
  if (isRoutineRequest(req) || wantsCookStart(req) || isWhoCooking(req)) return false;
  if (/shopping|grocer/.test(req)) return false;
  const wantsPlan =
    /\b(plan|make|create|generate|build|design|draft|put together|come up with|figure out|map out|schedule|sort out|organize)\b/.test(req) ||
    /^(menu|meal plan)/.test(req) ||
    /what should we (eat|cook|make|have)/.test(req);
  const aboutMeals = /\b(meal|meals|dinner|dinners|diner|menu|week|supper|eat|eating|food)\b/.test(req);
  return wantsPlan && aboutMeals;
}

/** "today / tonight / this week" => the week we're in (so tonight is covered), otherwise next week. */
function weekFor(req: string): string {
  return /\b(todays?|tonight'?s?|this (week|evening|monday)|right now|now)\b/.test(req) ? thisMonday() : nextMonday();
}

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
};

/** "mark the first step done" / "done with step 3" → 1-based routine step index (null if unclear). */
function routineStepIndex(req: string): number | null {
  if (!/\b(step|routine|checklist|prep|instruction)\b/.test(req)) return null;
  const m = req.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|\d+(?:st|nd|rd|th)?)\b/);
  if (!m?.[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : (ORDINALS[m[1]] ?? null);
}

/** Typos survive vowel-stripping: "berakfast"/"breakfast" both collapse to "brkfst". */
const stripVowels = (s: string) => s.replace(/[aeiou]/g, "");

/** Which moment of the day the request is about (breakfast / lunch / snack / light), or null. */
function mealKind(req: string): string | null {
  const r = req.toLowerCase();
  if (/\b(breakfast|brunch)\b/.test(r) || stripVowels(r).includes("brkfst")) return "breakfast";
  if (/\blunch(es)?\b/.test(r)) return "lunch";
  if (/\bsnack(s)?\b/.test(r)) return "snack";
  if (/\b(light|lighter)\b/.test(r)) return "light";
  return null;
}

function routeIntent(req: string): Call[] {
  const today = todayLocal();

  // Routine first: "plan tonight's evening routine" also contains "plan" + "dinner".
  // Read the plan first so the chain can plan a week that actually covers tonight.
  if (isRoutineRequest(req)) return [call("mealplan.list")];

  if (wantsCookStart(req)) return [call("cooking.status")];
  if (isWhoCooking(req)) return [call("mealplan.list")];

  const addMatch = req.match(/add[^,.!]*?(.+?)\s+to the shopping list/);
  if (addMatch?.[1]) return [call("shopping.add", { name: addMatch[1].trim(), quantity: 1, unit: "" })];

  if (
    /(shopping|grocer|store|buy|purchase|pick ?up|errand|supplies)/.test(req) &&
    /(week|meal plan|dinner|sync|update|from the plan|need)/.test(req)
  ) {
    return [call("shopping.sync_from_mealplan")];
  }
  if (/(shopping list|grocer|to buy|buy list|what to buy|grocery list)/.test(req)) return [call("shopping.list")];

  const pantryAdd = req.match(/\badd\s+([^,!.]+?)\s+to the (?:pantry|shelf|cupboard)/);
  if (pantryAdd?.[1]) return [call("pantry.add", { name: pantryAdd[1].trim(), quantity: 1, unit: "" })];

  // Preference writes lose to an explicit "plan …" request — the allergy/diet
  // wording is carried into the planner via planNote instead.
  if (!wantsMealPlan(req)) {
    // Names are capitalized for the tool, but this runs on a lowercased request.
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const dietSet = req.match(/\b(?:make|set)\s+([a-z]+)\s+(vegan|vegetarian|pescatarian)\b/);
    if (dietSet?.[1] && dietSet[2]) return [call("family.set_preferences", { memberName: cap(dietSet[1]), diet: [dietSet[2]] })];

    const allergySet = req.match(/\b([a-z]+)\s+(?:is\s+)?(dairy|peanut|gluten|nuts?|shellfish)\s+allerg/);
    if (allergySet?.[1] && allergySet[2]) {
      return [
        call("family.set_preferences", {
          memberName: cap(allergySet[1]),
          diet: [],
          allergies: [allergySet[2].replace(/nut$/, "nut")],
        }),
      ];
    }
  }

  if (/\b(next|advance|continue|another)\b/.test(req) && /\b(step|cooking|instruction)\b/.test(req)) return [call("cooking.advance")];

  const stepIdx = routineStepIndex(req);
  if (stepIdx !== null && /\b(mark|check off|tick|done|finished|completed|complete)\b/.test(req)) {
    return [call("routine.complete_step", { stepIndex: stepIdx })];
  }

  if (/\bcook(ing)?\b|hungry|what'?s cooking/.test(req)) return [call("cooking.status")];

  // Breakfast / lunch / snack / light-meal asks are recipe suggestions, not the
  // dinner plan — must come before wantsMealPlan ("plan this week's breakfast").
  const kind = mealKind(req);
  if (kind) return [call("recipe.suggest", { meal: kind })];

  if (wantsMealPlan(req)) return [call("mealplan.generate", { note: planNote(req), weekStart: weekFor(req) })];

  if (/(pantry|stock|inventory|do we have|what do we have|supplies)/.test(req)) return [call("pantry.list")];
  const makeWith = req.match(/\bwhat (?:can|could|should) we make (?:with|from|out of)\s+([\w\s-]+)/);
  if (makeWith?.[1]) return [call("recipe.search", { query: makeWith[1].trim() })];
  if (/(recipe|what can we make|cookbook)/.test(req)) return [call("recipe.list")];
  if (/\b(who|whose|everyone|anyone)\b/.test(req) && /\b(home|house|around|here|lives|living|family|member)\b/.test(req)) {
    return [call("family.list")];
  }
  if (/\b(home|status|household|everyone|anyone|family|member)\b/.test(req)) return [call("household.get_status")];

  return [];
}

/**
 * Looser second pass so casual phrasing still lands on a sensible tool.
 * Only read-only tools here — anything that writes state must be matched precisely.
 */
function bestEffort(req: string): Call[] {
  const kind = mealKind(req);
  if (kind) return [call("recipe.suggest", { meal: kind })];
  const buckets: [RegExp, Call[]][] = [
    [/\b(routine|wind (me |us )?down|winddown|bedtime|for bed|evening plan|tonight'?s plan)\b/, [call("routine.plan_evening", { date: todayLocal() })]],
    [/\b(grocer|groceries|shopping|store|buy|purchase|pick ?up|errand|cart|checkout)\b/, [call("shopping.list")]],
    [/\b(pantry|shelf|shelves|stock|inventory|supplies|cupboard)\b/, [call("pantry.list")]],
    [/\b(cook|cooking|kitchen|stove|oven|hungry|chop|simmer|preheat)\b/, [call("cooking.status")]],
    [/\b(recipe|cookbook|bake|dish)\b/, [call("recipe.list")]],
    [/\b(who|whose)\b.*\b(home|lives|around)\b/, [call("family.list")]],
    [/\b(meal|menu|dinner|dinners|diner|supper|week|eat|eating|food|plan)\b/, [call("mealplan.list")]],
    [/\b(household|family|member|home|status|everyone|anyone)\b/, [call("household.get_status")]],
  ];
  for (const [re, calls] of buckets) if (re.test(req)) return calls;
  return [];
}

/**
 * Follow-up tools for a multi-step request, given what already ran this turn.
 * e.g. "start dinner" => read the plan => (plan the week) => start the session.
 */
function nextStep(req: string, ran: Set<string>, outputs: Map<string, string>): Call[] {
  const r = req.toLowerCase();
  const week = weekFor(r);

  // "What do we need from the store?" with no plan yet: plan the week, then re-sync.
  if (outputs.get("shopping.sync_from_mealplan")?.includes("No meal plan to sync against")) {
    if (!ran.has("mealplan.generate")) return [call("mealplan.generate", { note: planNote(r), weekStart: week })];
    return [call("shopping.sync_from_mealplan")];
  }

  // Same precedence as routeIntent: routine wins over the cook-start reading
  // of "start tonight's evening routine".
  if (isRoutineRequest(r)) {
    if (ran.has("routine.plan_evening")) return [];
    if (planCovers(outputs, todayLocal())) return [call("routine.plan_evening", { date: todayLocal() })];
    if (!ran.has("mealplan.list")) return [call("mealplan.list")];
    if (!ran.has("mealplan.generate")) return [call("mealplan.generate", { note: planNote(r), weekStart: week })];
    return [call("routine.plan_evening", { date: todayLocal() })];
  }

  if (wantsCookStart(r)) {
    if (ran.has("cooking.start")) return [];
    const status = outputs.get("cooking.status") ?? "";
    if (status && !/No active cooking session/i.test(status)) return []; // already cooking — just report it
    if (!ran.has("cooking.status")) return [call("cooking.status")];
    const dish = planDish(outputs);
    if (dish) return [call("cooking.start", { dish })];
    if (!ran.has("mealplan.list")) return [call("mealplan.list")];
    if (!ran.has("mealplan.generate")) return [call("mealplan.generate", { note: planNote(r), weekStart: week })];
    return [];
  }

  if (isWhoCooking(r)) {
    if (planLines(outputs).length) return [];
    if (!ran.has("mealplan.list")) return [call("mealplan.list")];
    if (!ran.has("mealplan.generate")) return [call("mealplan.generate", { note: planNote(r), weekStart: week })];
    return [];
  }

  return [];
}

function planText(outputs: Map<string, string>): string {
  return [...outputs.values()].filter((v) => v.includes("cooked by")).join("\n");
}

function planLines(outputs: Map<string, string>): string[] {
  return planText(outputs).split("\n").filter((l) => l.includes("cooked by"));
}

function planCovers(outputs: Map<string, string>, date: string): boolean {
  return planLines(outputs).some((l) => l.includes(date));
}

function planDish(outputs: Map<string, string>): string | undefined {
  return dishToCook(planText(outputs));
}

function dishToCook(planText: string): string | undefined {
  const lines = planText.split("\n").filter((l) => l.includes("cooked by"));
  if (!lines.length) return undefined;
  const chosen = lines.find((l) => l.includes(todayLocal())) ?? lines[0];
  if (!chosen) return undefined;
  const line = chosen.trim();
  const start = line.indexOf(": ");
  const name = start >= 0 ? line.slice(start + 2) : line;
  const cut = name.indexOf(" cooked by ");
  const dish = (cut > 0 ? name.slice(0, cut) : name).replace(/[\s\u2014-]+$/, "").trim();
  return dish || undefined;
}

// ── answer shaping ─────────────────────────────────────────────────────────

function summarize(request: string, results: ToolResultMessage[], ran: Set<string>): string {
  const r = request.toLowerCase();

  if (isWhoCooking(r)) return whoIsCooking(results);

  // "start tonight's evening routine" also reads as a cook-start — the routine
  // reading wins, exactly as it does in routeIntent/nextStep.
  const showsSession = results.some((x) => /cooking session started|cooking "/i.test(x.content));
  if (wantsCookStart(r) && !isRoutineRequest(r) && !showsSession) {
    return 'I have no dinner lined up to start — there is no meal plan yet. Ask me to "plan next week\'s dinners", then say "start cooking".';
  }

  const sections = results.map((r2) => {
    const translated = r2.content
      .replace(
        "No meal plan yet. Use mealplan.generate to plan the week.",
        'There is no meal plan yet — say "plan this week\'s dinners" and I will build one.',
      )
      .replace(
        "No meal plan to sync against. Generate one first with mealplan.generate.",
        'There is no meal plan to sync yet — say "plan this week\'s dinners" and I will build the plan and shopping list together.',
      )
      .replace(
        /No routine for \d{4}-\d{2}-\d{2}\./,
        'There is no evening routine yet — say "plan tonight\'s evening routine" and I will build one.',
      );
    const body = translated.length > 900 ? translated.slice(0, 900) + "…" : translated;
    return r2.isError ? `⚠️ something went wrong:\n${body}` : body;
  });
  const joined = sections.join("\n\n");

  // Breakfast / light-meal suggestions arrive already well formatted.
  const kind = mealKind(r);
  const offered = ran.has("recipe.suggest") || ran.has("recipe.list") || ran.has("recipe.search");
  if (kind && offered && !results.some((x) => x.isError)) {
    if (kind === "breakfast" && /\b(todays?|tonight|tomorrow|this morning)\b/.test(r) && !/\b(week|rotate|rotation)\b/.test(r)) {
      return breakfastFor(joined, /\btomorrow\b/.test(r) ? 1 : 0) ?? joined;
    }
    if (kind === "breakfast" && /\b(plan|week|schedul|rotat)/.test(r)) return breakfastPlan(joined) ?? joined;
    return joined;
  }
  return joined;
}

/** "What's for breakfast today/tomorrow" — one pick from the rotation, with a backup. */
function breakfastFor(body: string, offset: number): string | null {
  const items = body
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
  if (!items.length) return null;
  const idx = (new Date(`${todayLocal()}T00:00:00`).getDay() + offset) % items.length;
  const pick = items[idx];
  const alt = items[(idx + 1) % items.length];
  const when = offset === 1 ? "Tomorrow" : `Today (${todayLocal()})`;
  return `${when} — ${pick}.\n\nBackup: ${alt}.\n\nBreakfasts are suggestions only — the weekly meal plan stays dinners.`;
}

/** Turn recipe suggestions into a Mon–Sun breakfast rotation. */
function breakfastPlan(body: string): string | null {
  const items = body
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
  if (!items.length) return null;
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const rows = days.map((day, i) => `${day}: ${items[i % items.length]}`);
  const header =
    items.length >= days.length
      ? "Breakfast plan for this week:"
      : `Breakfast plan for this week (rotating ${items.length} go-to's):`;
  return `${header}\n${rows.join("\n")}\n\nBreakfasts are suggestions — the weekly meal plan stays dinners, so swap any day you like.`;
}

interface PlanLine {
  day: string;
  date: string;
  dish: string;
  cook: string;
  labels: string;
}

function parsePlanLine(line: string): PlanLine | null {
  const m = line.trim().match(/^(\w+)\s+(\d{4}-\d{2}-\d{2}):\s+(.*?)\s+cooked by\s+(.+)$/);
  const [, day, date, dishRaw, cookRaw] = m ?? [];
  if (!day || !date || !dishRaw || !cookRaw) return null;
  const labels = cookRaw.match(/\[([^\]]*)\]\s*$/)?.[1]?.trim() ?? "";
  return {
    day,
    date,
    dish: dishRaw.replace(/[\s\u2014-]+$/, "").trim(),
    cook: cookRaw.replace(/\s*\[[^\]]*\]\s*$/, "").replace(/\s*\(.*$/, "").trim(),
    labels,
  };
}

function whoIsCooking(results: ToolResultMessage[]): string {
  const plan = results.map((x) => x.content).find((c) => c.includes("cooked by"));
  if (!plan) return "Nobody's assigned yet — there's no meal plan. Ask me to plan the week first.";

  const parsed = plan
    .split("\n")
    .map(parsePlanLine)
    .filter((p): p is PlanLine => p !== null);
  if (!parsed.length) return "The meal plan has no cooks assigned yet.";

  const today = todayLocal();
  const tonight = parsed.find((p) => p.date === today);
  const header = tonight
    ? `Tonight (${tonight.date}): ${tonight.cook} is cooking ${tonight.dish}${tonight.labels ? ` (${tonight.labels})` : ""}.`
    : `No dinner is planned for today (${today}) — the current plan starts ${parsed[0]?.date ?? "the coming week"}.`;

  const week = parsed
    .map((p) => `- ${p.day} ${p.date}: ${p.cook} cooks ${p.dish}${p.labels ? ` (${p.labels})` : ""}`)
    .join("\n");
  return `${header}\n\nThis week:\n${week}`;
}

function defaultAnswer(request: string): string {
  if (/vegetarian|vegan|diet|preference|allerg/.test(request)) {
    return 'I can adapt the weekly meal plan to your household\'s preferences and allergies. Ask me to "plan next week\'s dinners, vegetarian on Tuesdays and Thursdays", and I\'ll regenerate the plan and refresh your shopping list.';
  }
  if (/^(hi|hello|hey|yo)\b/.test(request)) return "Hi — I'm Hearth 🔥. Try: \"plan next week's dinners\", \"what do we need from the store?\", or \"start cooking\".";
  return "I'm Hearth — your household task orchestrator. I manage the meal plan, pantry, shopping list, cooking sessions, and the evening routine. Try: \"plan next week's dinners\", \"what do we need from the store?\", \"who is cooking tonight\", or \"start tonight's evening routine\".";
}

// ── note extraction for mealplan.generate ──────────────────────────────────

const DAY_PATTERNS: [RegExp, string][] = [
  [/\bmondays?\b|\bmon\b/, "Mondays"],
  [/\btuesdays?\b|\btues?\b|\btue\b/, "Tuesdays"],
  [/\bwednesdays?\b|\bweds?\b|\bwed\b/, "Wednesdays"],
  [/\bthursdays?\b|\bthurs?\b|\bthur\b|\bthu\b/, "Thursdays"],
  [/\bfridays?\b|\bfri\b/, "Fridays"],
  [/\bsaturdays?\b|\bsat\b/, "Saturdays"],
  [/\bsundays?\b|\bsun\b/, "Sundays"],
];

function dayNames(req: string): string[] {
  return DAY_PATTERNS.filter(([re]) => re.test(req)).map(([, name]) => name);
}

/** Distill the request into the short instruction the meal planner honors. */
function planNote(req: string): string {
  const bits: string[] = [];
  const wantsVeg = /(vegetarian|vegan|meatless|plant[- ]based|veggie)/.test(req);
  const noVeg = /(no|without|not|none|free of)[-\s,]*veget|non[-\s]?veg|no meatless/.test(req);
  const days = dayNames(req);

  if (noVeg) bits.push("no vegetarian days");
  else if (wantsVeg && days.length) bits.push(`vegetarian on ${days.join(" and ")}`);
  else if (wantsVeg) bits.push("vegetarian");

  const allergy = req.match(/\b([a-z]+)\s+allerg/);
  if (allergy) bits.push(`${allergy[1]} allergy`);

  return bits.join("; ");
}
