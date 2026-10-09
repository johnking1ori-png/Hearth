# DEMO.md — 3-minute demo script & story

The narrated story for the hackathon video. **Do not reveal agent internals in the
narration** — the point is what Alexa+ does *for* the family; the live trace is the "how".

> Household: **The Talents** — Alex (works late, dairy-allergic), Sam (cooks plant-based).
> Pantry already has basics. Voice assistant = Hearth through Alexa+.

---

### 0:00–0:20 — Setup (voice-over over the UI)

- "Introducing **Hearth** — an MCP server for Alexa+ that runs a household: meal planning,
  shopping, cooking, and evening routines from a single sentence."
- "Behind the scenes, Hearth advertises 25 MCP tools to Alexa's agent and executes the
  plan *live through the same MCP endpoint*. You can watch every tool call stream in."

---

### 0:20–0:55 — Turn 1 · Plan the week

> **Alex to Hearth:** "Plan next week's dinners. We're vegetarian on Tuesdays and
> **Thursdays, and I'm dairy allergic.**"

- UI shows the generated week (7 unique dishes, plant-based Tue/Thu, no dairy anywhere).
- Camera highlight: `mealplan.generate` tool run + the dashboard updating.
- Line: "Constraints in, plan out — recipes chosen so every dish is dairy-free and the
  right cook is assigned."

---

### 0:55–1:25 — Turn 2 · Sync the shopping list

> **Alex:** "What do we need to buy for the week, given the plan and what's in the pantry?"

- Hearth diffs the plan against the pantry and adds the 27 shortfalls to the shopping
  list — narration reads a couple: "Red bell peppers, soy sauce, ground beef, tzatziki."
- Camera highlight: `shopping.sync_from_mealplan` trace + shopping-list tab.

---

### 1:25–1:55 — Turn 3 · Start tonight's cooking session

> **Sam:** "Start tonight's dinner and walk me through the first steps."

- Cooking session opens with the correct dish, timers, and step-by-step checks
  (ingredients, kitchen, pan hot, etc.).
- Camera highlight: `cooking.start` (with a pantry/ingredient check) + `cooking.advance`.

---

### 1:55–2:35 — Turn 4 · Plan the evening routine

> **Alex:** "Plan our evening so dinner's ready at 7."

- Nightly routine generated (start 17:55 → prep → cook → temp check → serve 19:00 →
  clear up), driven by the meal plan.
- Camera highlight: `routine.plan_evening` trace; plus `household.get_status` refreshing
  the household dashboard.

---

### 2:35–3:00 — Bedrock + notes

- "On Amazon Bedrock, Hearth runs the same loop with real LLM tool-calling — Claude
  decides which tools to call from the MCP schema." (one line, optional clip)
- "The web app is the *simulated Alexa+* front-end; the exact same MCP server runs in any
  Streamable-HTTP MCP client."
- Close with repo + license.

---

## Recording tips

- **Recalibrate dates:** the meal plan covers *next Monday onwards*. For a demo where
  "tonight" falls inside the planned week, record on a day whose evening routine you want
  to show, and seed with `npm run seed` before each take so counts stay clean.
- **Reset state between takes:** `npm run seed` then restart `npm run dev`.
- **Bedrock clip:** set `HEARTH_LLM_PROVIDER=bedrock`; `/health` should read
  `"bedrock": true`. The `agent` badge in the UI flips to Bedrock + model ID. (Optional —
  local router works offline identically for the script.)
- Screen: use the Vite UI at `http://localhost:5173`, window ~1280×800, browser zoom 100%.