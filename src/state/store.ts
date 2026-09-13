import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { HouseholdState, ShoppingItem } from "../shared/types.js";
import { RECIPES } from "../shared/recipes.js";
import { WEEK_DAYS } from "../shared/types.js";

export function seedState(householdName = "The Talents", timezone = "America/New_York"): HouseholdState {
  return {
    householdName,
    timezone,
    family: [
      { id: "m1", name: "Alex", diet: ["vegetarian"], favorites: ["tofu-stir-fry", "vegan-chili", "coconut-black-beans"], allergies: ["dairy"] },
      { id: "m2", name: "Sam", diet: ["none"], favorites: ["beef-tacos", "garlic-butter-steak", "lemon-garlic-salmon"], allergies: ["peanuts"] },
    ],
    pantry: [
      { id: "p1", name: "rice", category: "grains", quantity: 800, unit: "g" },
      { id: "p2", name: "penne", category: "grains", quantity: 400, unit: "g" },
      { id: "p3", name: "black beans", category: "canned", quantity: 3, unit: "cans" },
      { id: "p4", name: "kidney beans", category: "canned", quantity: 1, unit: "can" },
      { id: "p5", name: "crushed tomatoes", category: "canned", quantity: 1400, unit: "g" },
      { id: "p6", name: "olive oil", category: "pantry", quantity: 750, unit: "ml" },
      { id: "p7", name: "garlic", category: "produce", quantity: 6, unit: "cloves" },
      { id: "p8", name: "onion", category: "produce", quantity: 3, unit: "" },
      { id: "p9", name: "eggs", category: "dairy & eggs", quantity: 10, unit: "" },
      { id: "p10", name: "firm tofu", category: "protein", quantity: 400, unit: "g" },
      { id: "p11", name: "coconut milk", category: "canned", quantity: 2, unit: "cans" },
      { id: "p12", name: "broccoli", category: "produce", quantity: 300, unit: "g" },
      { id: "p13", name: "chicken breast", category: "protein", quantity: 600, unit: "g" },
      { id: "p14", name: "butter", category: "dairy & eggs", quantity: 250, unit: "g" },
    ],
    mealPlan: null,
    shoppingList: [
      { id: "s1", name: "coffee beans", quantity: 500, unit: "g", category: "pantry", source: "manual", checked: false },
      { id: "s2", name: "dish soap", quantity: 1, unit: "bottle", category: "home", source: "manual", checked: false },
    ],
    recipes: RECIPES,
    cookingSession: null,
    routines: [],
    updatedAt: new Date().toISOString(),
  };
}

export type ChangeListener = (state: HouseholdState) => void;

/**
 * File-backed persistent store. This is what gives Hearth its
 * "remember across sessions" superpower — MCP sessions, and even
 * server restarts, all share one household reality.
 */
export class HouseholdStore {
  private state: HouseholdState;
  private file: string;
  private listeners = new Set<ChangeListener>();

  constructor(file: string) {
    this.file = resolve(file);
    this.state = this.load();
    this.persist();
  }

  private load(): HouseholdState {
    const example = resolve(this.file.replace(/\.json$/, ".example.json"));
    if (!existsSync(this.file) && existsSync(example)) {
      copyFileSync(example, this.file);
    }
    if (!existsSync(this.file)) {
      return seedState();
    }
    try {
      const raw = readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as Partial<HouseholdState>;
      const seed = seedState();
      return { ...seed, ...parsed, recipes: RECIPES };
    } catch {
      // Corrupt state file — start fresh rather than crash.
      return seedState();
    }
  }

  private persist(): void {
    this.state.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf-8");
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Read the current household reality. */
  getState(): HouseholdState {
    return this.state;
  }

  /** Mutate household state safely; persists and notifies listeners. */
  update(mutator: (state: HouseholdState) => void): HouseholdState {
    const draft = structuredClone(this.state);
    mutator(draft);
    this.state = draft;
    this.persist();
    return this.state;
  }

  resetToSeed(): void {
    this.state = seedState(this.state.householdName, this.state.timezone);
    this.persist();
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Local-timezone yyyy-mm-dd (UTC slices can shift days near midnight). */
export function toLocalYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayLocal(): string {
  return toLocalYmd(new Date());
}

export function nextMonday(from = new Date()): string {
  const d = new Date(from);
  const day = (d.getDay() + 6) % 7; // Monday = 0 … Sunday = 6
  // Monday → today; any other day → the coming Monday (Sunday ⇒ tomorrow).
  if (day > 0) d.setDate(d.getDate() + (7 - day));
  return toLocalYmd(d);
}

export function dayOfWeekFor(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return WEEK_DAYS[(d.getDay() + 6) % 7] ?? "Monday";
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return toLocalYmd(d);
}

export function upsertShoppingItem(
  list: ShoppingItem[],
  name: string,
  quantity: number,
  unit: string,
  category: string,
  source: "manual" | "plan" | "auto",
): ShoppingItem[] {
  const key = name.trim().toLowerCase();
  const existing = list.find((i) => i.name.trim().toLowerCase() === key);
  if (existing) {
    existing.quantity = Math.max(existing.quantity, quantity);
    existing.source = source === "plan" ? existing.source : source;
    if (!existing.unit) existing.unit = unit;
    return list;
  }
  list.push({ id: newId("s"), name: name.trim(), quantity, unit, category, source, checked: false });
  return list;
}

const CATEGORY_BY_NAME: Record<string, string> = {
  rice: "grains",
  "black beans": "canned",
  "kidney beans": "canned",
  "crushed tomatoes": "canned",
  "coconut milk": "canned",
  chicken: "protein",
  beef: "protein",
  tofu: "protein",
  salmon: "protein",
  eggs: "dairy & eggs",
};

export function guessCategory(name: string): string {
  const lower = name.toLowerCase();
  const hit = Object.keys(CATEGORY_BY_NAME).find((k) => lower.includes(k));
  if (hit) return CATEGORY_BY_NAME[hit]!;
  if (lower.includes("cheese") || lower.includes("milk") || lower.includes("cream") || lower.includes("butter")) return "dairy & eggs";
  if (lower.includes("tomato") || lower.includes("lettuce") || lower.includes("pepper") || lower.includes("onion") || lower.includes("garlic") || lower.includes("broccoli") || lower.includes("cucumber") || lower.includes("zucchini")) return "produce";
  return "pantry";
}

