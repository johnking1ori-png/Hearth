# Hearth · Household Task Orchestrator

An agentic **MCP (Model Context Protocol) server** designed for **Alexa+** that turns one
sentence of household math into a planned, timed, and partially-executed evening:

> "Plan next week's dinners — vegetarian on Tuesdays and Thursdays, Alex is dairy-allergic."

…becomes a full weekly meal plan, a pantry diff, a synced shopping list, a cooking
session, and an evening routine that self-runs against its own tools.

It ships with a **real MCP agent loop** (`orchestrate.task`): the LLM receives the full
MCP tool surface and drives the household state **through the same Streamable HTTP MCP
endpoint any Alexa+ client would use** — so the runtime *is* the demo.

---

## What you can do

| Prompt | What happens |
|---|---|
| "Plan next week's dinners, vegetarian Tue/Thu" | 7 unique dairy-free dinners, household-assigned |
| "What do we need to buy?" | Meal plan × pantry ⇒ shopping list diff |
| "Start tonight's dinner" | Cooking session with ingredient & step checks |
| "Plan our evening" | Timed routine that reports back through MCP tools |
| "Suggest a breakfast" / "Plan this week's breakfast" | `recipe.suggest` → 7-day breakfast rotation (dinners stay in the plan) |
| "Is everyone at home?" / "Who's cooking?" | Live household intents |

A simulated Alexa+ chat web app (`npm run web`) shows a **live agent trace** — every MCP
tool call the LLM makes, streamed over SSE — alongside a household dashboard.

## Architecture

```
Alexa+  ── MCP (Streamable HTTP, 2025-11-25) ──►  /mcp      Hearth server (Express + MCPSDK)
                                                    ├── 25 tools (mealplan.*, cooking.*,
        Browser (simulated Alexa+) ◄── SSE ─────────┤      shopping.*, routine.*, family.*, pantry.*,
        /v1/chat                                    │      recipe.*)       └── orchestrate.task ──► MCP Client
        web/ (React + Vite)                         │                                │
                                                    └── /api/household · /health   actual MCP roundtrip
```

- **State** lives in `data/household.json` (file-backed store), so the "brain" remembers
  the household across sessions — long-term memory by default.
- **LLM providers** (`HEARTH_LLM_PROVIDER`):
  - `bedrock` — Amazon Bedrock (Claude via the Converse API, tool calling included).
  - `local` — a deterministic intent router (works offline, great for CI/demos).
  - `auto` (default) — Bedrock when AWS credentials are configured, otherwise local.
- **Deterministic domain logic** (meal planner, shopping diff) is guaranteed correct even
  when the planner is a regex — the LLM only plays `tool-caller`.

## Quick start

```bash
npm install
npm run seed        # create data/household.json for "The Talents"
npm run dev         # API + MCP on http://localhost:4000 (provider: auto)
```

In another terminal:

```bash
npm run web         # open the simulated Alexa+ UI at http://localhost:5173
```

### Use from an MCP client (e.g. Claude Desktop)

MCP servers support **Streamable HTTP** — point a client at `http://localhost:4000/mcp`.

```json
{
  "mcpServers": {
    "hearth": {
      "type": "http",
      "url": "http://localhost:4000/mcp"
    }
  }
}
```

Claude Desktop ≥ v0.66.3 supports HTTP MCP servers. (`{"transport":"http","url":...}` if
your client expects the old field name.)

### Bedrock (required for the AWS Builder mini-challenge)

```bash
# PowerShell
$env:HEARTH_LLM_PROVIDER="bedrock"
$env:HEARTH_AWS_REGION="us-east-1"
```
```bash
# bash
export HEARTH_LLM_PROVIDER=bedrock
```

- Credentials resolve from AWS SSO, env vars, or a profile on disk.
- Default model: `us.anthropic.claude-haiku-4-5-20251001-v1:0` (inference profile) —
  override with `HEARTH_BEDROCK_MODEL`.
- `GET /health` reports whether Bedrock is configured (`"bedrock": true`).
- Settings can live in a `.env` file at the repo root (loaded automatically); `.env.example`
  documents every key. `isBedrockConfigured()` looks for `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE` — so a plain `aws configure` default profile needs
  `AWS_PROFILE=default` set for auto-detection to pick Bedrock.

### Smoke test

```bash
npm run demo        # boots the full stack in-process, runs the 4-turn storyline
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start the server (tsx watch) |
| `npm start` | Start the server (production-ish) |
| `npm run seed` | Reset `data/household.json` from the example |
| `npm run demo` | In-process end-to-end smoke test (no browser) |
| `npm run agent` | CLI REPL that talks to a running server |
| `npm run test:edge` | 34-case edge/intent battery against a running server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run web` | Vite dev server for the simulated Alexa+ UI |
| `npm run web:build` | Build the UI into `web/dist` (served by `npm run dev`) |

## Repository contents

```
src/
  server/        Express app: /mcp (Streamable HTTP), /v1/chat (SSE), SPA, /api/*, /health
  agent/         Bedrock + local providers, MCP client, agent loop, provider factory
  services/      mealPlanner, shoppingSync, routinePlanner (deterministic domain logic)
  state/         file-backed household store, seed data, date helpers
  shared/        recipe book (17 recipes), MCP tool schemas
web/             React + Vite "Alexa+" chat UI with live agent trace
data/            household.json (runtime state) + household.example.json (committed seed)
```

## Demo storyline (3 minutes — see DEMO.md)

Turns run back-to-back and reuse state:

1. **Plan** the week (respects the veg days + dairy allergy).
2. **Shop** — meal plan × pantry ⇒ shortfall list auto-added to the shopping list.
3. **Cook** — start a cooking session, get ingredient/step checks.
4. **Wind down** — plan the evening routine around dinner time.

## Known limitations & friction log

Filed table of kinks with the MCP SDK, Express 5, and Bedrock — see `SUBMISSION.md`
(also available as product feedback for the Devpost submission).