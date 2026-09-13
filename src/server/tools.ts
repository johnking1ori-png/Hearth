import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HouseholdStore, nextMonday, newId, upsertShoppingItem, guessCategory, todayLocal } from "../state/store.js";
import { findRecipe } from "../shared/recipes.js";
import type { MealPlanDay } from "../shared/types.js";
import { generateDeterministicMealPlan, mealPlanPrompt, parseModelMealPlan } from "../services/mealPlanner.js";
import { computeShortfalls, mergeShortfalls, summarizeShortfall } from "../services/shoppingSync.js";
import { planRoutine, routineForDate, resolveRoutineStep, startCookingSession, advanceCooking, recipeForDish } from "../services/routinePlanner.js";
import { BedrockProvider, BedrockError, isBedrockConfigured } from "../agent/provider.js";
import { buildAutoProvider } from "../agent/factory.js";
import { runAgentTask } from "../agent/agentLoop.js";
import { mcpClient } from "../agent/mcpClient.js";
import { config } from "../config/env.js";

export function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

export function registerTools(server: McpServer, store: HouseholdStore) {
  registerHousehold(server, store);
  registerFamily(server, store);
  registerPantry(server, store);
  registerRecipes(server, store);
  registerMealPlan(server, store);
  registerShopping(server, store);
  registerCooking(server, store);
  registerRoutine(server, store);
  registerOrchestrate(server, store);
}

/**
 * One McpServer per client session: the SDK's `McpServer.connect()` rejects a
 * second simultaneous transport, so every HTTP session gets its own server that
 * shares the same household store. Tools stay stateless w.r.t. connection.
 */
export function createHearthMcpServer(store: HouseholdStore): McpServer {
  const server = new McpServer({ name: "hearth", version: "1.0.0" });
  registerTools(server, store);
  return server;
}

function registerHousehold(server: McpServer, store: HouseholdStore) {
  server.registerTool(
    "household.get_status",
    {
      title: "Household status",
      description:
        "Return a full, human-readable snapshot of the household: members + dietary prefs, pantry counts, the current weekly meal plan, shopping list, cooking session, and evening routine. Call this before answering most questions.",
      inputSchema: z.object({}),
    },
    async () => {
      return textResult(householdStatusText(store.getState()));
    },
  );
}

function registerFamily(server: McpServer, store: HouseholdStore) {
  server.registerTool(
    "family.set_preferences",
    {
      title: "Set family preferences",
      description:
        "Update a household member's dietary preferences and allergies (e.g. make someone vegetarian, note a dairy allergy). The meal planner reads these on every generation.",
      inputSchema: z.object({
        memberName: z.string().describe("Name of the family member, e.g. 'Alex'"),
        diet: z.array(z.string()).describe("Diet tags, e.g. ['vegetarian']"),
        favorites: z.array(z.string()).optional().describe("Favorite recipe ids or dishes"),
        allergies: z.array(z.string()).optional().describe("Allergies, e.g. ['peanuts'] or ['dairy']"),
      }),
    },
    async (args) => {
      const a = args as { memberName: string; diet: string[]; favorites?: string[]; allergies?: string[] };
      let msg = "";
      store.update((s) => {
        const member = s.family.find((m) => m.name.toLowerCase() === a.memberName.toLowerCase());
        if (!member) {
          msg = `No family member named "${a.memberName}". Members: ${s.family.map((m) => m.name).join(", ")}.`;
          return;
        }
        const updated: string[] = [];
        if (a.diet?.length) {
          member.diet = a.diet as never;
          updated.push(`diet → [${a.diet.join(", ")}]`);
        }
        if (a.favorites) {
          member.favorites = a.favorites;
          updated.push(`favorites updated`);
        }
        if (a.allergies) {
          member.allergies = a.allergies;
          updated.push(`allergies → [${a.allergies.join(", ")}]`);
        }
        msg = `Updated ${member.name}: ${updated.join("; ")}.`;
      });
      return textResult(msg);
    },
  );
}

function registerPantry(server: McpServer, store: HouseholdStore) {
  server.registerTool(
    "pantry.list",
    {
      title: "List pantry",
      description:
        "List everything currently in the pantry with quantities and units. Use for readiness checks before planning or cooking.",
      inputSchema: z.object({}),
    },
    async () => {
      const s = store.getState();
      if (!s.pantry.length) return textResult("The pantry is empty.");
      const lines = s.pantry.map((p) => `- ${p.name}: ${p.quantity}${p.unit ? " " + p.unit : ""}${p.note ? ` (${p.note})` : ""}`);
      return textResult(`Pantry (${s.pantry.length} items):\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "pantry.add",
    {
      title: "Add pantry item",
      description: "Add an item to the pantry, or bump its quantity if it already exists.",
      inputSchema: z.object({
        name: z.string().describe("Ingredient name, e.g. 'olive oil'"),
        quantity: z.number().optional().describe("Quantity (default 1)"),
        unit: z.string().optional().describe("Unit, e.g. 'g', 'ml', 'cans', or ''"),
        category: z.string().optional().describe("Optional category, e.g. 'produce', else guessed"),
      }),
    },
    async (args) => {
      const a = args as { name: string; quantity?: number; unit?: string; category?: string };
      let inserted = false;
      store.update((s) => {
        const existing = s.pantry.find((p) => p.name.trim().toLowerCase() === a.name.trim().toLowerCase());
        if (existing) {
          existing.quantity += a.quantity ?? 1;
        } else {
          s.pantry.push({
            id: newId("p"),
            name: a.name.trim(),
            category: a.category?.trim() || guessCategory(a.name),
            quantity: a.quantity ?? 1,
            unit: a.unit?.trim() ?? "",
          });
          inserted = true;
        }
      });
      return textResult(inserted ? `Added "${a.name}" to the pantry.` : `Updated "${a.name}" in the pantry.`);
    },
  );

  server.registerTool(
    "pantry.update",
    {
      title: "Update pantry quantity",
      description: "Adjust the quantity of an existing pantry item (or remove it if quantity drops to 0).",
      inputSchema: z.object({
        name: z.string().describe("Pantry item name"),
        quantity: z.number().describe("New quantity (set 0 to remove)"),
        unit: z.string().optional().describe("Optional unit change"),
      }),
    },
    async (args) => {
      const a = args as { name: string; quantity: number; unit?: string };
      let msg = "";
      store.update((s) => {
        const item = s.pantry.find((p) => p.name.toLowerCase() === a.name.toLowerCase());
        if (!item) {
          msg = `No pantry item "${a.name}". Use pantry.add instead.`;
          return;
        }
        if (a.quantity <= 0) {
          s.pantry = s.pantry.filter((p) => p.id !== item.id);
          msg = `Removed "${a.name}" from the pantry.`;
        } else {
          item.quantity = a.quantity;
          if (a.unit) item.unit = a.unit;
          msg = `Set ${item.name} to ${a.quantity}${item.unit ? " " + item.unit : ""}.`;
        }
      });
      return textResult(msg);
    },
  );

  server.registerTool(
    "pantry.remove",
    {
      title: "Remove pantry item",
      description: "Remove an item from the pantry entirely.",
      inputSchema: z.object({ name: z.string().describe("Pantry item name") }),
    },
    async (args) => {
      const a = args as { name: string };
      let removed = false;
      store.update((s) => {
        const before = s.pantry.length;
        s.pantry = s.pantry.filter((p) => p.name.toLowerCase() !== a.name.toLowerCase());
        removed = s.pantry.length < before;
      });
      return textResult(removed ? `Removed "${a.name}".` : `No pantry item named "${a.name}".`, !removed);
    },
  );
}

function registerRecipes(server: McpServer, store: HouseholdStore) {
  server.registerTool(
    "recipe.list",
    {
      title: "List recipes",
      description: "List the household's recipe library: dish names, prep time, and diet tags.",
      inputSchema: z.object({}),
    },
    async () => {
      const s = store.getState();
      const lines = s.recipes.map((r) => `- ${r.name} (${r.prepMinutes}m, diet: ${r.diet.join("/") || "none"})`);
      return textResult(`${s.recipes.length} recipes in the library:\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "recipe.search",
    {
      title: "Search recipes",
      description: "Search recipes by keyword, tag, or diet requirement.",
      inputSchema: z.object({
        query: z.string().describe("Search term, e.g. 'vegan', 'quick', 'chicken'"),
      }),
    },
    async (args) => {
      const q = (args as { query: string }).query.toLowerCase();
      const s = store.getState();
      const hits = s.recipes.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q)) ||
          r.diet.some((d) => d.toLowerCase().includes(q)) ||
          r.ingredients.some((i) => i.name.toLowerCase().includes(q)),
      );
      if (!hits.length) return textResult(`No recipes match "${q}". Try recipe.list to browse.`);
      return textResult(hits.map((r) => `- ${r.name} (${r.prepMinutes}m, diet: ${r.diet.join("/") || "none"})`).join("\n"));
    },
  );

  server.registerTool(
    "recipe.get",
    {
      title: "Get recipe",
      description: "Get the full recipe: ingredients with quantities and step-by-step instructions.",
      inputSchema: z.object({ recipeId: z.string().describe("Recipe id (from recipe.list or meal plan)") }),
    },
    async (args) => {
      const id = (args as { recipeId: string }).recipeId;
      const recipe = findRecipe(id);
      if (!recipe) return textResult(`No recipe with id "${id}".`, true);
      const ing = recipe.ingredients.map((i) => `- ${i.name}: ${i.quantity}${i.unit ? " " + i.unit : ""}`).join("\n");
      const steps = recipe.steps.map((s2, i) => `${i + 1}. ${s2}`).join("\n");
      return textResult(`# ${recipe.name}\n(${recipe.prepMinutes} min, serves ${recipe.servings})\n\nIngredients:\n${ing}\n\nSteps:\n${steps}`);
    },
  );
}

function registerMealPlan(server: McpServer, store: HouseholdStore) {
  server.registerTool(
    "mealplan.list",
    {
      title: "List meal plan",
      description: "Show the current weekly meal plan day by day, with the cook for each night.",
      inputSchema: z.object({}),
    },
    async () => {
      const s = store.getState();
      if (!s.mealPlan) return textResult("No meal plan yet. Use mealplan.generate to plan the week.");
      return textResult(planToText(s.mealPlan));
    },
  );

  server.registerTool(
    "mealplan.generate",
    {
      title: "Generate meal plan",
      description:
        "Generate a 7-day dinner meal plan starting on the next Monday (or a given weekStart). Honors household diets, allergies, day-of-week instructions in the note (e.g. 'vegetarian on Tuesdays and Thursdays'), and the recipe library. Uses Amazon Bedrock when available.",
      inputSchema: z.object({
        weekStart: z.string().optional().describe("ISO date (yyyy-mm-dd) of the Monday starting the week; defaults to this week's Monday"),
        note: z.string().optional().describe("Instructions, e.g. 'vegetarian on Tuesdays and Thursdays' or 'Alex cooks on weekends'"),
      }),
    },
    async (args) => {
      const a = args as { weekStart?: string; note?: string };
      const s = store.getState();
      const weekStart = a.weekStart ?? nextMonday();
      const plan = await buildMealPlan(s, weekStart, a.note ?? "");
      store.update((draft) => {
        draft.mealPlan = plan;
      });
      return textResult(`Generated a new meal plan (model: ${plan.model}).\n\n${planToText(plan)}`);
    },
  );

  server.registerTool(
    "mealplan.set",
    {
      title: "Override a meal-plan day",
      description: "Replace one night's dish in the meal plan, optionally changing who cooks.",
      inputSchema: z.object({
        date: z.string().describe("ISO date (yyyy-mm-dd) of the day to change"),
        dish: z.string().describe("The new dish name"),
        recipeId: z.string().optional().describe("Optional recipe id from the recipe library"),
        cook: z.string().optional().describe("Who cooks that night"),
      }),
    },
    async (args) => {
      const a = args as { date: string; dish: string; recipeId?: string; cook?: string };
      let found = false;
      store.update((s) => {
        const day = s.mealPlan?.days.find((d) => d.date === a.date);
        if (!day) return;
        found = true;
        day.dish = a.dish;
        if (a.recipeId) day.recipeId = a.recipeId;
        if (a.cook) day.cook = a.cook;
      });
      if (!found) return textResult(`No meal-plan day on ${a.date}. Check mealplan.list.`, true);
      return textResult(`Updated ${a.date} → ${a.dish}${a.cook ? ` (cook: ${a.cook})` : ""}.`);
    },
  );
}

function registerShopping(server: McpServer, store: HouseholdStore) {
  server.registerTool(
    "shopping.list",
    {
      title: "List shopping list",
      description: "Show the current shopping list grouped by category, with what is already checked.",
      inputSchema: z.object({}),
    },
    async () => {
      const s = store.getState();
      if (!s.shoppingList.length) return textResult("Shopping list is empty.");
      const groups = new Map<string, typeof s.shoppingList>();
      for (const item of s.shoppingList) {
        const arr = groups.get(item.category) ?? [];
        arr.push(item);
        groups.set(item.category, arr);
      }
      const lines = [...groups.entries()].map(([cat, items]) => {
        const detail = items
          .map((i) => `${i.checked ? "[x]" : "[ ]"} ${i.name} ${i.quantity}${i.unit ? " " + i.unit : ""}${i.source === "plan" ? " (from meal plan)" : ""}`)
          .join("\n  ");
        return `- ${cat}:\n  ${detail}`;
      });
      return textResult(`Shopping list (${s.shoppingList.length} items):\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "shopping.add",
    {
      title: "Add shopping item",
      description: "Add an item to the shopping list manually.",
      inputSchema: z.object({
        name: z.string().describe("Item name, e.g. 'dish soap'"),
        quantity: z.number().optional().describe("Quantity (default 1)"),
        unit: z.string().optional().describe("Unit, e.g. 'g', 'bottle', or ''"),
        category: z.string().optional().describe("Optional category"),
      }),
    },
    async (args) => {
      const a = args as { name: string; quantity?: number; unit?: string; category?: string };
      store.update((s) => {
        s.shoppingList = upsertShoppingItem(s.shoppingList, a.name, a.quantity ?? 1, a.unit ?? "", a.category ?? guessCategory(a.name), "manual");
      });
      return textResult(`"${a.name}" is on the shopping list.`);
    },
  );

  server.registerTool(
    "shopping.mark",
    {
      title: "Mark shopping item",
      description: "Mark a shopping-list item as checked (bought) or uncheck it.",
      inputSchema: z.object({
        name: z.string().describe("Item name"),
        checked: z.boolean().optional().describe("Default true (mark as bought)"),
      }),
    },
    async (args) => {
      const a = args as { name: string; checked?: boolean };
      let found = false;
      store.update((s) => {
        const item = s.shoppingList.find((i) => i.name.toLowerCase() === a.name.toLowerCase());
        if (item) {
          found = true;
          item.checked = a.checked ?? true;
        }
      });
      return textResult(found ? `Marked "${a.name}" as ${a.checked ?? true ? "bought" : "to buy"}.` : `No item "${a.name}" on the list.`, !found);
    },
  );

  server.registerTool(
    "shopping.sync_from_mealplan",
    {
      title: "Sync shopping list from meal plan",
      description:
        "Cross-reference every ingredient in the current weekly meal plan against the pantry and merge the shortfalls into the shopping list. Essential after generating a meal plan.",
      inputSchema: z.object({}),
    },
    async () => {
      const s = store.getState();
      if (!s.mealPlan) return textResult("No meal plan to sync against. Generate one first with mealplan.generate.", true);
      const shortfalls = computeShortfalls(s, s.mealPlan);
      let bought: typeof s.shoppingList = [];
      store.update((draft) => {
        bought = mergeShortfalls(draft.shoppingList, shortfalls);
      });
      return textResult(summarizeShortfall(shortfalls, bought));
    },
  );
}

function registerCooking(server: McpServer, store: HouseholdStore) {
  server.registerTool(
    "cooking.start",
    {
      title: "Start cooking session",
      description: "Begin a step-by-step cooking session for a dish, optionally from a recipe. Use for tonight's planned dish.",
      inputSchema: z.object({
        dish: z.string().describe("Dish name to cook"),
        recipeId: z.string().optional().describe("Recipe id to load steps from"),
      }),
    },
    async (args) => {
      const a = args as { dish: string; recipeId?: string };
      const s = store.getState();
      const recipe = a.recipeId ? findRecipe(a.recipeId) : recipeForDish(s, a.dish);
      const session = startCookingSession(a.dish, recipe);
      store.update((draft) => {
        draft.cookingSession = session;
      });
      return textResult(
        `Cooking session started for "${session.dish}" (${session.steps.length} steps).\n\n${session.steps.map((st) => `${st.stepNumber}. ${st.instruction}${st.timerMinutes ? ` (timer: ${st.timerMinutes} min)` : ""}`).join("\n")}`,
      );
    },
  );

  server.registerTool(
    "cooking.status",
    {
      title: "Cooking status",
      description: "Show the current cooking session, current step, and what's next.",
      inputSchema: z.object({}),
    },
    async () => {
      const s = store.getState();
      const c = s.cookingSession;
      if (!c) return textResult("No active cooking session. Use cooking.start.");
      const current = c.steps[c.currentStep - 1];
      const next = c.steps[c.currentStep];
      const lines = [`Cooking "${c.dish}" — status: ${c.status}`, `Step ${c.currentStep}/${c.steps.length}: ${current?.instruction ?? "—"}`];
      if (next) lines.push(`Next: ${next.instruction}`);
      else if (c.status !== "done") lines.push("Final step — plate up and serve!");
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "cooking.advance",
    {
      title: "Advance cooking step",
      description: "Mark the current step done and move to the next one. When the last step finishes, the session is done.",
      inputSchema: z.object({}),
    },
    async () => {
      const s = store.getState();
      if (!s.cookingSession) return textResult("No active cooking session.", true);
      const advanced = advanceCooking(structuredClone(s.cookingSession));
      store.update((draft) => {
        draft.cookingSession = advanced;
      });
      if (advanced.status === "done") return textResult(`"${advanced.dish}" is done — dinner time!`);
      return textResult(`Step ${advanced.currentStep}/${advanced.steps.length}: ${advanced.steps[advanced.currentStep - 1]?.instruction ?? ""}`);
    },
  );
}

function registerRoutine(server: McpServer, store: HouseholdStore) {
  server.registerTool(
    "routine.plan_evening",
    {
      title: "Plan evening routine",
      description:
        "Build the evening routine for a date: a timed schedule (prep → cook → serve → clear up) that lands dinner on the table at the household's dinner time, driven by the dish on that night's meal plan.",
      inputSchema: z.object({
        date: z.string().optional().describe("ISO date (yyyy-mm-dd) to plan; defaults to today"),
      }),
    },
    async (args) => {
      const a = args as { date?: string };
      const dateStr = a.date ?? todayLocal();
      let routineTextOut = "";
      store.update((s) => {
        const day = s.mealPlan?.days.find((d) => d.date === dateStr);
        const dish = day?.dish ?? "tonight's dinner";
        const recipe = dish ? recipeForDish(s, dish) : undefined;
        const routine = planRoutine(s, dateStr, { date: dateStr, dish, prepMinutes: recipe?.prepMinutes ?? 35 });
        s.routines = s.routines.filter((r) => r.date !== dateStr);
        s.routines.push(routine);
        routineTextOut = routineToText(routine);
      });
      return textResult(`Evening routine for ${dateStr} is set.\n\n${routineTextOut}`);
    },
  );

  server.registerTool(
    "routine.get",
    {
      title: "Get evening routine",
      description: "Show the evening routine for a given date (default today), with each timed step and whether it's done.",
      inputSchema: z.object({ date: z.string().optional().describe("ISO date (yyyy-mm-dd)") }),
    },
    async (args) => {
      const a = args as { date?: string };
      const dateStr = a.date ?? todayLocal();
      const routine = routineForDate(store.getState(), dateStr);
      if (!routine) {
        return textResult(`No evening routine for ${dateStr}. Ask me to plan the evening.`);
      }
      return textResult(routineToText(routine));
    },
  );

  server.registerTool(
    "routine.complete_step",
    {
      title: "Complete routine step",
      description: "Mark a step of the current evening routine as done (e.g. 'started cooking').",
      inputSchema: z.object({
        date: z.string().optional().describe("ISO date (yyyy-mm-dd)"),
        stepIndex: z.number().describe("1-based index of the step to mark done"),
      }),
    },
    async (args) => {
      const a = args as { date?: string; stepIndex: number };
      const dateStr = a.date ?? todayLocal();
      let out = "";
      store.update((s) => {
        const routine = s.routines.find((r) => r.date === dateStr);
        if (!routine) {
          out = `No routine for ${dateStr}.`;
          return;
        }
        resolveRoutineStep(routine, a.stepIndex - 1);
        out = `Marked "${routine.steps[a.stepIndex - 1]?.task ?? "step"}" complete.\n\n${routineToText(routine)}`;
      });
      return textResult(out);
    },
  );
}

function registerOrchestrate(server: McpServer, store: HouseholdStore) {
  server.registerTool(
    "orchestrate.task",
    {
      title: "Orchestrate a household task",
      description:
        "Autonomous multi-step task orchestration: understand a free-form household request and chain the other Hearth tools automatically to complete it (meal planning → shopping sync → routine). Use this for anything the user asks in plain language that needs more than one tool. Args: request = the user's words.",
      inputSchema: z.object({ request: z.string().describe("The user's request exactly as they said it") }),
    },
    async (args) => {
      const request = (args as { request: string }).request;
      const provider = buildAutoProvider();
      const outcome = await runAgentTask({ request, provider, mcp: mcpClient });
      return textResult(`Task orchestrated (provider ${outcome.provider}, ${outcome.toolCalls} tool calls):\n\n${outcome.text}`);
    },
  );
}

export function planToText(plan: { days: MealPlanDay[] }): string {
  return plan.days
    .map((d) => `${d.dayOfWeek} ${d.date}: ${d.dish}${d.cook ? ` — cooked by ${d.cook}` : ""}${d.notes ? ` (${d.notes})` : ""}`)
    .join("\n");
}

function routineToText(routine: {
  title: string;
  status: string;
  steps: { time: string; task: string; detail?: string; resolved: boolean }[];
}): string {
  const steps = routine.steps
    .map((s2) => `${s2.resolved ? "[x]" : "[ ]"} ${s2.time} — ${s2.task}${s2.detail ? ` (${s2.detail})` : ""}`)
    .join("\n");
  return `# ${routine.title} — ${routine.status}\n${steps}`;
}

function householdStatusText(s: ReturnType<HouseholdStore["getState"]>): string {
  const lines: string[] = [`Household: ${s.householdName}`];
  lines.push(`Members: ${s.family.map((m) => `${m.name} [${m.diet.join(",") || "no diet"}]`).join(", ")}`);
  lines.push(`Pantry items: ${s.pantry.length}`);
  if (s.mealPlan) {
    lines.push(`\nMeal plan (week of ${s.mealPlan.weekStart}, model ${s.mealPlan.model}):`);
    lines.push(planToText(s.mealPlan).split("\n").map((l) => "  " + l).join("\n"));
  } else {
    lines.push("\nMeal plan: not generated yet");
  }
  lines.push(`\nShopping list items: ${s.shoppingList.length} (${s.shoppingList.filter((i) => i.checked).length} checked)`);
  const c = s.cookingSession;
  lines.push(`Cooking: ${c ? `"${c.dish}" step ${c.currentStep}/${c.steps.length} (${c.status})` : "no active session"}`);
  const tonight = routineForDate(s, todayLocal());
  lines.push(`Evening routine: ${tonight ? `${tonight.title} — ${tonight.status}` : "not planned for today"}`);
  return lines.join("\n");
}

async function buildMealPlan(
  s: ReturnType<HouseholdStore["getState"]>,
  weekStart: string,
  note: string,
): Promise<ReturnType<typeof generateDeterministicMealPlan>> {
  const useBedrock = config.llmProvider === "bedrock" || (config.llmProvider === "auto" && isBedrockConfigured());
  if (useBedrock) {
    const provider = new BedrockProvider();
    try {
      const res = await provider.complete({
        system: "You are the meal planner for a household. Return ONLY the requested JSON array, no markdown.",
        messages: [{ role: "user", content: mealPlanPrompt(s, weekStart, note) }],
        tools: [],
      });
      const parsed = parseModelMealPlan(res.text ?? "", s, weekStart, provider.model);
      if (parsed) return parsed;
    } catch (err) {
      if (err instanceof BedrockError) {
        return generateDeterministicMealPlan(s, weekStart, note);
      }
      throw err;
    }
  }
  return generateDeterministicMealPlan(s, weekStart, note);
}