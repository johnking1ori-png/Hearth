export type DietTag =
  | "vegan"
  | "vegetarian"
  | "pescatarian"
  | "gluten-free"
  | "dairy-free"
  | "nut-free"
  | "low-sodium"
  | "none";

export interface FamilyMember {
  id: string;
  name: string;
  diet: DietTag[];
  favorites: string[];
  allergies: string[];
}

export interface PantryItem {
  id: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  note?: string;
}

export type WeekDay = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday";

export interface MealPlanDay {
  date: string; // yyyy-mm-dd
  dayOfWeek: WeekDay;
  dish: string;
  recipeId?: string;
  cook?: string;
  notes?: string;
}

export interface MealPlan {
  weekStart: string; // yyyy-mm-dd (Monday)
  days: MealPlanDay[];
  generatedAt: string;
  model: string; // provider used to generate, e.g. "us.anthropic.claude-haiku-4-5-..." or "hearth-deterministic"
}

export type ShoppingSource = "manual" | "plan" | "auto";

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  source: ShoppingSource;
  checked: boolean;
}

export interface RecipeIngredient {
  name: string;
  quantity: number;
  unit: string;
}

export interface Recipe {
  id: string;
  name: string;
  category: string;
  tags: string[];
  diet: DietTag[];
  prepMinutes: number;
  servings: number;
  ingredients: RecipeIngredient[];
  steps: string[];
}

export interface CookingStep {
  stepNumber: number;
  instruction: string;
  timerMinutes?: number;
}

export interface CookingSession {
  id: string;
  dish: string;
  recipeId?: string;
  startedAt: string;
  status: "preparing" | "cooking" | "done";
  currentStep: number;
  steps: CookingStep[];
}

export interface RoutineStep {
  time: string; // "18:00"
  timeMinutes: number; // minutes from midnight
  task: string;
  detail?: string;
  resolved: boolean;
  tool?: string; // related Hearth tool name, if any
}

export interface EveningRoutine {
  id: string;
  date: string; // yyyy-mm-dd
  title: string;
  steps: RoutineStep[];
  status: "queued" | "active" | "completed";
  generatedAt: string;
}

export interface HouseholdState {
  householdName: string;
  timezone: string;
  family: FamilyMember[];
  pantry: PantryItem[];
  mealPlan: MealPlan | null;
  shoppingList: ShoppingItem[];
  recipes: Recipe[];
  cookingSession: CookingSession | null;
  routines: EveningRoutine[];
  updatedAt: string;
}

export interface AgentToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  ok: boolean;
  durationMs: number;
}

export interface AgentTrace {
  request: string;
  provider: string;
  model: string;
  steps: AgentToolCall[];
  answer: string;
  durationMs: number;
  completedAt: string;
}

export const WEEK_DAYS: WeekDay[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];