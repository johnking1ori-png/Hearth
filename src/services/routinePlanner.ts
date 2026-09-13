import type { CookingSession, CookingStep, EveningRoutine, HouseholdState, RoutineStep, Recipe } from "../shared/types.js";
import { config } from "../config/env.js";
import { findRecipe } from "../shared/recipes.js";
import { newId } from "../state/store.js";

export interface RoutineDraft {
  date: string; // yyyy-mm-dd
  dish: string;
  prepMinutes: number;
}

function dinnerTimeMinutes(): number {
  const [h, m] = config.dinnerTime.split(":").map(Number);
  return (h ?? 19) * 60 + (m ?? 0);
}

function fmtTime(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Build an evening routine that has a dish ready at the household's dinner time. */
export function planRoutine(state: HouseholdState, date: string, draft: RoutineDraft): EveningRoutine {
  const dinnerMin = dinnerTimeMinutes();
  const prep = Math.max(draft.prepMinutes, 15);
  const tStart = dinnerMin - prep - 30; // earliest anchor

  const step = (timeMinutes: number, task: string, detail?: string, tool?: string): RoutineStep => ({
    time: fmtTime(timeMinutes),
    timeMinutes,
    task,
    detail,
    resolved: false,
    tool,
  });

  const steps: RoutineStep[] = [
    step(tStart, "Start the evening routine", `Tonight: ${draft.dish}. Make sure the kitchen is clear.`),
    step(tStart + 10, "Prep ingredients", "Wash, chop, and portion what you'll need."),
    step(tStart + prep, "Start cooking", `${draft.dish} is going on the stove/oven.`, "cooking"),
    step(dinnerMin - 10, "Temperature check", "Check for doneness; season to taste."),
    step(dinnerMin, "Serve dinner", `${draft.dish} hits the table.`, "cooking"),
    step(dinnerMin + 45, "Clear up", "Load the dishwasher, wipe down the counters."),
  ];

  return {
    id: newId("rt"),
    date,
    title: `Evening routine — ${draft.dish}`,
    steps,
    status: "queued",
    generatedAt: new Date().toISOString(),
  };
}

export function routineForDate(state: HouseholdState, date: string): EveningRoutine | undefined {
  return [...state.routines].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)).find((r) => r.date === date);
}

export function resolveRoutineStep(routine: EveningRoutine, stepIndex: number): EveningRoutine {
  const target = routine.steps[stepIndex];
  if (target) target.resolved = true;
  const allDone = routine.steps.every((s) => s.resolved);
  if (allDone) routine.status = "completed";
  else if (routine.status === "queued") routine.status = "active";
  return routine;
}

export function startCookingSession(dish: string, recipe?: Recipe): CookingSession {
  const steps: CookingStep[] = recipe
    ? recipe.steps.map((instruction, i) => ({
        stepNumber: i + 1,
        instruction,
        timerMinutes: i === recipe.steps.length - 1 && recipe.prepMinutes > 25 ? Math.min(recipe.prepMinutes - 20, 15) : undefined,
      }))
    : [
        { stepNumber: 1, instruction: `Gather ingredients for ${dish}.` },
        { stepNumber: 2, instruction: "Follow the prepared steps for this dish." },
        { stepNumber: 3, instruction: "Plate and serve." },
      ];

  return {
    id: newId("ck"),
    dish,
    recipeId: recipe?.id,
    startedAt: new Date().toISOString(),
    status: "preparing",
    currentStep: 1,
    steps,
  };
}

export function advanceCooking(session: CookingSession): CookingSession {
  if (session.status === "done") return session;
  if (session.currentStep >= session.steps.length) {
    session.status = "done";
    return session;
  }
  session.currentStep += 1;
  if (session.currentStep > session.steps.length) session.status = "done";
  return session;
}

export function recipeForDish(state: HouseholdState, dish: string): Recipe | undefined {
  const byId = findRecipe(dish);
  if (byId) return byId;
  return state.recipes.find((r) => r.name.toLowerCase() === dish.toLowerCase());
}