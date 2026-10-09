/**
 * Edge-case battery for Hearth.
 *
 * Runs every prompt below against a *running* server (`npm run dev`) over the real
 * /v1/chat SSE endpoint — the same path the web UI uses — and asserts on the tool
 * trace, the final answer, and (where it matters) the resulting household state.
 *
 *   npm run test:edge            # requires the dev server on :4000
 *   HEARTH_URL=http://127.0.0.1:4100 npm run test:edge
 *
 * Exit code 1 if any case fails.
 */

const BASE = process.env.HEARTH_URL ?? "http://127.0.0.1:4000";

interface ChatResult {
  tools: string[];
  answer: string;
}

interface Case {
  name: string;
  message: string;
  fresh?: boolean; // reset household state first (for recovery-path cases)
  expectTools?: string[]; // exact sequence, in order
  expect?: RegExp; // answer must match
  forbid?: RegExp[]; // answer must NOT match
  state?: (h: Household) => string | null; // return a failure reason, or null when ok
}

interface Household {
  family: { name: string; diet: string[]; allergies: string[] }[];
  pantry: { name: string }[];
  mealPlan: { days: { recipeId?: string }[] } | null;
  shoppingList: { name: string; checked: boolean }[];
  cookingSession: { currentStep: number; steps: unknown[] } | null;
  routines: { steps: { resolved: boolean }[] }[];
}

async function chat(message: string, sessionId: string): Promise<ChatResult> {
  const res = await fetch(`${BASE}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId }),
  });
  if (!res.ok || !res.body) throw new Error(`chat failed: ${res.status}`);
  const text = await res.text();
  const tools: string[] = [];
  let answer = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const ev = JSON.parse(line.slice(6)) as { type: string; name?: string; content?: string };
    if (ev.type === "tool_start" && ev.name) tools.push(ev.name);
    if (ev.type === "done" && ev.content) answer = ev.content;
  }
  return { tools, answer };
}

const getState = async (): Promise<Household> =>
  (await fetch(`${BASE}/api/household`)).json() as Promise<Household>;

const reset = async (): Promise<void> => {
  await fetch(`${BASE}/api/reset`, { method: "POST" });
};

const cases: Case[] = [
  // ── README "What you can do" promises ─────────────────────────────────────
  {
    name: "plan: diet + allergy note becomes a labeled week",
    message:
      "Plan next week's dinners. We're vegetarian on Tuesdays and Thursdays — Alex is dairy allergic.",
    expectTools: ["mealplan.generate"],
    expect: /\bWeek mix:/,
    state: (h) =>
      h.mealPlan && h.mealPlan.days.length === 7 && h.mealPlan.days.every((d) => d.recipeId)
        ? null
        : "expected 7 planned days, all with recipeId",
  },
  {
    name: "shopping: plan × pantry ⇒ shortfall diff",
    message: "What do we need to buy this week?",
    expectTools: ["shopping.sync_from_mealplan"],
    expect: /Shortfalls|Nothing missing/,
  },
  {
    name: "cooking: start dinner with ingredient + step checks",
    message: "start cooking",
    expect: /Cooking session started[\s\S]*Pantry check[\s\S]*1\./,
    state: (h) => (h.cookingSession ? null : "expected an active cooking session"),
  },
  {
    name: "routine: evening plan anchored to tonight's dish",
    message: "Plan tonight's evening routine so dinner lands at 7pm on the dot.",
    expect: /Evening routine[\s\S]*\[ \]/,
    state: (h) => (h.routines.length ? null : "expected an evening routine"),
  },
  {
    name: "breakfast: suggestion list with meal-type labels",
    message: "suggest me a breakfast",
    expectTools: ["recipe.suggest"],
    expect: /breakfast options:[\s\S]*\[/,
  },
  {
    name: "breakfast: plan this week's rotation",
    message: "plan this week's breakfast",
    expect: /Breakfast plan for this week:[\s\S]*Monday:[\s\S]*Sunday:/,
  },
  {
    name: "breakfast: today's pick instead of the week",
    message: "plan todays breakfast menu",
    expectTools: ["recipe.suggest"],
    expect: /Today \(\d{4}-\d{2}-\d{2}\)/,
    forbid: [/Breakfast plan for this week/],
  },
  {
    name: "household: who is cooking tonight",
    message: "who is cooking tonight",
    expectTools: ["mealplan.list"],
    expect: /Tonight \(.*\): .* is cooking|cooks .* \[/,
  },

  // ── recovery paths (state intentionally incomplete) ──────────────────────
  {
    name: "recover: shopping with no plan plans first, then syncs",
    fresh: true,
    message: "what do we need from the store?",
    expectTools: ["shopping.sync_from_mealplan", "mealplan.generate", "shopping.sync_from_mealplan"],
    expect: /Shortfalls|Nothing missing/,
    forbid: [/No meal plan to sync/i],
  },
  {
    name: "recover: routine with no plan generates the week first",
    fresh: true,
    message: "plan tonight's evening routine",
    expect: /Evening routine[\s\S]*\[ \]/,
    forbid: [/No meal plan yet/i],
    state: (h) => (h.routines.length ? null : "expected an evening routine"),
  },
  {
    name: "write: complete a routine step (routine just planned)",
    message: "mark the first step done",
    expectTools: ["routine.complete_step"],
    state: (h) =>
      h.routines.some((r) => r.steps.some((s) => s.resolved))
        ? null
        : "no routine step marked resolved",
  },
  {
    name: "recover: cooking with no plan plans first",
    fresh: true,
    message: "start cooking",
    expect: /Cooking session started/,
    state: (h) => (h.cookingSession ? null : "expected a session after chain"),
  },
  {
    name: "recover: routine step with no routine ⇒ friendly fallback",
    message: "mark the first step done",
    expect: /evening routine yet/i,
    forbid: [/No routine for \d/i],
  },

  // ── write intents ────────────────────────────────────────────────────────
  {
    name: "write: add to shopping list",
    message: "add hot sauce to the shopping list",
    expectTools: ["shopping.add"],
    state: (h) =>
      h.shoppingList.some((i) => i.name.toLowerCase().includes("hot sauce"))
        ? null
        : "hot sauce missing from shopping list",
  },
  {
    name: "write: add to pantry",
    message: "add olive oil to the pantry",
    expectTools: ["pantry.add"],
    state: (h) =>
      h.pantry.some((i) => i.name.toLowerCase().includes("olive oil"))
        ? null
        : "olive oil missing from pantry",
  },
  {
    name: "write: set a preference (planner input)",
    message: "make Alex vegan",
    expectTools: ["family.set_preferences"],
    state: (h) =>
      h.family.find((m) => m.name === "Alex")?.diet.includes("vegan")
        ? null
        : "Alex not marked vegan",
  },
  {
    name: "write: record an allergy",
    message: "Sam is peanut allergic",
    expectTools: ["family.set_preferences"],
    state: (h) =>
      h.family.find((m) => m.name === "Sam")?.allergies.some((a) => a.toLowerCase().includes("peanut"))
        ? null
        : "peanut allergy not recorded",
  },
  {
    name: "write: advance the cooking session",
    message: "next step",
    expectTools: ["cooking.advance"],
    state: (h) =>
      h.cookingSession && h.cookingSession.currentStep > 1
        ? null
        : "cooking step did not advance",
  },

  // ── reads & phrasing ─────────────────────────────────────────────────────
  { name: "greeting", message: "hi", expect: /Hearth/ },
  {
    name: "off-topic degrades gracefully",
    message: "tell me a joke",
    expect: /Hearth|Try|household/,
  },
  {
    name: "read: what's for dinner",
    message: "what's for dinner tonight",
    expectTools: ["mealplan.list"],
    expect: /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/,
  },
  { name: "read: pantry inventory", message: "do we have garlic", expect: /pantry/i },
  {
    name: "read: recipe search by ingredient",
    message: "what can we make with tofu",
    expectTools: ["recipe.search"],
    expect: /Tofu|tofu|No recipes match/,
  },
  {
    name: "read: family roster (not the status blob)",
    message: "is everyone at home?",
    expectTools: ["family.list"],
    expect: /members:[\s\S]*Alex[\s\S]*Sam/,
    forbid: [/Meal plan/],
  },
  {
    name: "read: shopping list",
    message: "show me the shopping list",
    expectTools: ["shopping.list"],
    expect: /item|Empty|Nothing/i,
  },

  // ── meal-moment routing ──────────────────────────────────────────────────
  {
    name: "lunch excludes breakfast and heavy dinners",
    message: "what about lunch",
    expectTools: ["recipe.suggest"],
    expect: /lunch options:/,
    forbid: [/Greek Yogurt Parfait/, /Overnight Oats/, /Garlic Butter Steak/, /One-Pot Vegan Chili/],
  },
  {
    name: "light meal suggestion",
    message: "what about a light meal",
    expectTools: ["recipe.suggest"],
    expect: /light options/,
  },
  {
    name: "breakfast typo (brekfast) still routes",
    message: "suggest brekfast",
    expectTools: ["recipe.suggest"],
    expect: /breakfast options/,
  },

  // ── typos, junk, and robustness ──────────────────────────────────────────
  {
    name: "typo: plan diner for nex week",
    message: "plan diner for nex week",
    expectTools: ["mealplan.generate"],
    expect: /Monday|Week mix:/,
  },
  {
    name: "whitespace-only input stays graceful",
    message: "   ",
    expect: /Hearth|Try|household/i,
  },
  {
    name: "junk input doesn't crash the agent",
    message: "<script>alert(1)</script> asdkjh 12345'; DROP TABLE",
    expect: /.+/,
  },
  {
    name: "long input doesn't crash the agent",
    message: `plan dinner ${"and also please remember ".repeat(80)}`,
    expect: /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Week mix/,
  },
  {
    name: "emoji input routes to the meal plan",
    message: "🍳🔥 plan dinner 🔥",
    expect: /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Week mix/,
  },
  {
    name: "session isolation: fresh session stays generic",
    message: "what did I ask you earlier?",
    expect: /Hearth|Try|household/i,
  },
];

const FORBID_ALWAYS = [
  /error while trying to reach/i,
  /No meal plan yet\. Use mealplan/i,
  /\[object Object\]/,
  /\bundefined\b/,
];

async function main(): Promise<void> {
  const health = (await fetch(`${BASE}/health`)
    .then((r) => r.json())
    .catch(() => null)) as { status?: string; household?: string } | null;
  if (!health?.status) {
    console.error(`edge-cases: no server at ${BASE} — start it with "npm run dev" first.`);
    process.exit(1);
  }

  console.log(`edge-cases: ${cases.length} cases against ${BASE} (household: ${health.household})\n`);
  await reset();

  let pass = 0;
  const failures: string[] = [];

  for (const c of cases) {
    const reasons: string[] = [];
    let res: ChatResult | null = null;
    try {
      if (c.fresh) await reset();
      res = await chat(c.message, `edge-${c.name.replace(/\W+/g, "-").slice(0, 40)}`);
      if (c.expectTools) {
        const got = res.tools.join(",");
        if (got !== c.expectTools.join(",")) reasons.push(`tools: want [${c.expectTools}] got [${got}]`);
      }
      if (c.expect && !c.expect.test(res.answer)) reasons.push(`answer did not match ${c.expect}`);
      for (const bad of c.forbid ?? []) {
        if (bad.test(res.answer)) reasons.push(`answer matched forbidden ${bad}`);
      }
      if (!res.answer.trim()) reasons.push("empty answer");
      for (const bad of FORBID_ALWAYS) {
        if (bad.test(res.answer)) reasons.push(`answer matched ${bad}`);
      }
      if (c.state) {
        const err = c.state(await getState());
        if (err) reasons.push(`state: ${err}`);
      }
    } catch (err) {
      reasons.push(`exception: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (reasons.length) {
      failures.push(c.name);
      console.log(`FAIL  ${c.name}`);
      for (const r of reasons) console.log(`      - ${r}`);
      if (res) {
        console.log(`      tools: [${res.tools.join(", ")}]`);
        console.log(`      answer: ${JSON.stringify(res.answer.slice(0, 240))}`);
      }
    } else {
      pass += 1;
      console.log(`ok    ${c.name}`);
    }
  }

  await reset();
  console.log(`\n${pass}/${cases.length} passed.`);
  if (failures.length) {
    console.log(`FAILED: ${failures.join(" | ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
