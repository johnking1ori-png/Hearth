import type { HouseholdState, MealPlan, PantryItem, RecipeIngredient, ShoppingItem } from "../shared/types.js";
import { newId, upsertShoppingItem } from "../state/store.js";

export interface ShortfallEntry {
  name: string;
  need: number;
  unit: string;
  category: string;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

function pantryMatch(pantry: PantryItem[], ingredient: RecipeIngredient): PantryItem | undefined {
  const target = normalize(ingredient.name);
  return pantry.find((p) => {
    const pn = normalize(p.name);
    return pn === target || pn.includes(target) || target.includes(pn);
  });
}

/** Diff meal-plan ingredients against pantry; return what needs buying. */
export function computeShortfalls(state: HouseholdState, plan: MealPlan): ShortfallEntry[] {
  const ingredients = new Map<string, { need: number; unit: string; category: string; name: string }>();
  for (const day of plan.days) {
    const recipe = state.recipes.find((r) => r.id === day.recipeId);
    if (!recipe) continue;
    for (const ing of recipe.ingredients) {
      const key = normalize(ing.name);
      const entry = ingredients.get(key) ?? { name: ing.name, need: 0, unit: ing.unit, category: "pantry" };
      entry.need += ing.quantity;
      if (!entry.unit && ing.unit) entry.unit = ing.unit;
      ingredients.set(key, entry);
    }
  }

  const shortfalls: ShortfallEntry[] = [];
  for (const [, need] of ingredients) {
    const pantry = pantryMatch(state.pantry, { name: need.name, quantity: need.need, unit: need.unit });
    if (!pantry) {
      shortfalls.push({ name: need.name, need: need.need, unit: need.unit, category: need.category });
      continue;
    }
    const unitCompatible = !pantry.unit || !need.unit || pantry.unit === need.unit;
    if (!unitCompatible) {
      // Unit mismatch (e.g. "cans" vs "g") — treat as available to avoid noise.
      continue;
    }
    const missing = need.need - pantry.quantity;
    if (missing > 0) {
      shortfalls.push({ name: need.name, need: missing, unit: need.unit, category: need.category });
    }
  }
  return shortfalls;
}

/** Merge computed shortfalls into the shopping list and return the merged list. */
export function mergeShortfalls(list: ShoppingItem[], shortfalls: ShortfallEntry[]): ShoppingItem[] {
  for (const s of shortfalls) {
    upsertShoppingItem(list, s.name, s.need, s.unit, s.category, "plan");
  }
  return list;
}

export function summarizeShortfall(shortfalls: ShortfallEntry[], bought: ShoppingItem[]): string {
  if (shortfalls.length === 0) return "Nothing missing — the pantry already covers every planned dish. 🎉";
  const byCat = new Map<string, ShortfallEntry[]>();
  for (const s of shortfalls) {
    const arr = byCat.get(s.category) ?? [];
    arr.push(s);
    byCat.set(s.category, arr);
  }
  const added = shortfalls.filter((s) => {
    const key = s.name.trim().toLowerCase();
    return bought.some((b) => b.name.trim().toLowerCase() === key && b.source === "plan");
  }).length;
  const lines = [...byCat.entries()].map(([cat, items]) => {
    const detail = items.map((i) => `${i.name} (${i.need}${i.unit ? " " + i.unit : ""})`).join(", ");
    return `  ${cat}: ${detail}`;
  });
  return `Shortfalls for the week (${added} auto-added to your shopping list):\n${lines.join("\n")}`;
}

export function manualShoppingItem(name: string, quantity: number, unit: string, category: string): ShoppingItem {
  return { id: newId("s"), name, quantity, unit, category, source: "manual", checked: false };
}