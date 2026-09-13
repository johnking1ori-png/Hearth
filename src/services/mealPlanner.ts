import type { HouseholdState, MealPlan, MealPlanDay, Recipe, WeekDay } from "../shared/types.js";
import { addDays, dayOfWeekFor, nextMonday, newId } from "../state/store.js";
import { findRecipe } from "../shared/recipes.js";

export interface PlanContext {
  weekStart: string;
  note?: string;
  targetDinnerTime?: string;
  useBedrock?: boolean;
}

function scoreRecipe(r: Recipe, state: HouseholdState, usedNames: Set<string>, index: number): number {
  const favorites = new Set(state.family.flatMap((m) => m.favorites));
  let score = 0;
  if (favorites.has(r.id)) score += 10;
  if (!usedNames.has(r.name)) score += 5;
  if (r.prepMinutes <= 30) score += 3;
  score -= index * 0.25; // slight penalty for ordering so days vary
  return score;
}

export function generateDeterministicMealPlan(state: HouseholdState, weekStart: string, note?: string): MealPlan {
  const members = state.family;
  const hasAllergy = (tag: string) => members.some((m) => m.allergies.map((a) => a.toLowerCase()).includes(tag));
  const allergyDairy = hasAllergy("dairy");
  const allergyPeanut = hasAllergy("peanuts") || hasAllergy("nuts") || hasAllergy("nut");
  const alwaysPlantOnly = members.some((m) => m.diet.includes("vegan"));

  const isPlantDay = (day: WeekDay): boolean =>
    alwaysPlantOnly || day === "Tuesday" || day === "Thursday";

  const usable = (r: Recipe, day: WeekDay): boolean => {
    if (isPlantDay(day) && !r.diet.includes("vegan") && !r.diet.includes("vegetarian")) return false;
    if (!isPlantDay(day) && alwaysPlantOnly) return false;
    if (allergyDairy && !r.diet.includes("dairy-free")) return false;
    if (allergyPeanut && !r.diet.includes("nut-free")) return false;
    return true;
  };

  const usedNames = new Set<string>();
  const cooks = members.length ? members.map((m) => m.name) : ["Hearth"];
  const days: MealPlanDay[] = [];

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const dayName = dayOfWeekFor(date) as WeekDay;
    const pool = state.recipes.filter((r) => usable(r, dayName));
    // Prefer dishes we haven't already assigned; fall back to the full pool
    // on a constrained day (e.g. plant-based Tuesdays/Thursdays) when needed.
    const fresh = pool.filter((r) => !usedNames.has(r.name));
    const candidates = fresh.length ? fresh : pool;
    const sorted = [...candidates].sort((a, b) => scoreRecipe(b, state, usedNames, i) - scoreRecipe(a, state, usedNames, i));
    const pick = sorted[0];
    if (!pick) continue;

    usedNames.add(pick.name);
    days.push({
      date,
      dayOfWeek: dayName,
      dish: pick.name,
      recipeId: pick.id,
      cook: cooks[i % cooks.length],
      notes: note ? `request: ${note}` : undefined,
    });
  }

  return {
    weekStart,
    days,
    generatedAt: new Date().toISOString(),
    model: "hearth-deterministic",
  };
}

/** Feed the recipe library to an LLM so it can pick 7 varied, diet-safe dishes. */
export function mealPlanPrompt(state: HouseholdState, weekStart: string, note?: string): string {
  const family = state.family.map((m) => `${m.name}: diet=[${m.diet.join(", ")}], allergies=[${m.allergies.join(", ")}], favorites=[${m.favorites.join(", ")}]`).join("\n");
  const library = state.recipes.map((r) => `- "${r.id}" | ${r.name} | ${r.prepMinutes}m | diet=[${r.diet.join(",")}] | tags=[${r.tags.join(",")}]`).join("\n");
  return `You are the meal planner for the household "${
    state.householdName
  }". Return ONLY a JSON array of 7 objects, one per day Monday->Sunday starting ${weekStart}.
Each object: {"day":"Monday","recipeId":"<id exactly as listed>","dish":"<same as recipe name>","note":"<one short line>"}.

Household members:
${family}
Available recipe library (pick ONLY from these):
${library}
${note ? `Also honor this instruction from the owner: ${note}` : ""}
Rules:
- Every dish must be safe for allergies (no peanuts for peanut-allergic, no dairy for dairy-allergic).
- Prefer recipes matching each member's favorites; give variety across the week.
- Do NOT repeat the same dish twice across the week.
- Vegan/vegetarian members should see matching plants-first meals most nights.
Respond with the array only, no markdown, no commentary.`;
}

export function parseModelMealPlan(raw: string, state: HouseholdState, weekStart: string, model: string): MealPlan | null {
  try {
    const cleaned = raw.replace(/^```(json)?/i, "").replace(/```\s*$/, "").trim();
    const arr = JSON.parse(cleaned) as { day: string; recipeId: string; dish: string; note?: string }[];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const byId = new Map(state.recipes.map((r) => [r.id, r]));
    const cooks = state.family.length ? state.family.map((m) => m.name) : ["Hearth"];
    const days: MealPlanDay[] = arr.slice(0, 7).map((entry, i) => {
      const recipe = byId.get(entry.recipeId) ?? state.recipes.find((r) => r.name === entry.dish);
      const date = addDays(weekStart, i);
      return {
        date,
        dayOfWeek: dayOfWeekFor(date) as WeekDay,
        dish: recipe?.name ?? entry.dish,
        recipeId: recipe?.id ?? entry.recipeId,
        cook: cooks[i % cooks.length],
        notes: entry.note,
      };
    });
    return { weekStart, days, generatedAt: new Date().toISOString(), model };
  } catch {
    return null;
  }
}

export { nextMonday, newId };

export type { MealPlanDay };