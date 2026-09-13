# SUBMISSION.md — Devpost copy, product feedback & friction log

Use this as the source for the Devpost submission, the demo video description, the
README file, and the $150 AWS credit request (`https://forms.gle/5hyhr1u6x3fuV2aW7`,
open until Oct 21, 2026 12pm PT).

---

## Devpost copy

**Project name:** Hearth — Household Task Orchestrator

**Tagline:** Give Alexa+ a sentence about your week; Hearth plans, shops, cooks, and winds
down the house.

**What it does:** Hearth is an MCP server for Alexa+ that manages a household as a
first-class stateful agent: it plans a week of dairy-aware, diet-aware dinners, diffs the
plan against the pantry to build a shopping list, runs a guided cooking session, and
generates a timed evening routine — and it does this by calling its **own 23 MCP tools
through the same Streamable HTTP endpoint any Alexa+ client uses**. A simulated-Alexa+
React UI streams every tool call live (SSE) so the agent's reasoning is visible, while the
same server runs in any MCP HTTP client.

**How we built it:** TypeScript full-stack.
- Server: Express + the official `@modelcontextprotocol/sdk` (Streamable HTTP transport,
  2025-11-25 spec), file-backed household state for cross-session memory.
- Agent: Bedrock (Claude via Converse + tool calling) with a deterministic local
  intent-router fallback so the stack runs offline / in CI. Domain logic (meal planner,
  shopping diff, routine timetables) stays deterministic — the LLM only calls tools.
- Front-end: React + Vite "Alexa+" screen with live agent trace and a data dashboard.

**Challenges we ran into:** MCP spec churn across the SDK, Express 5 route-pattern changes,
zod v4 validation inside the SDK, and convincing the Bedrock Converse API to describe MCP
tool schemas cleanly. Friction log below.

**Accomplishments we're proud of:** `orchestrate.task` — the MCP server drives itself
through a real MCP client round-trip, so the demo *is* the runtime. Long-term-memory demo
state ("The Talents" family) across sessions from a tiny file-backed store.

**What's next:** TTS turn-taking for real Alexa devices, Google Calendar + Zigbee/hue
routine triggers through more MCP servers, and household membership self-service.

**Tracks:** Alexa+ — MCP server backend (self-hosted). **Mini challenges:** AWS Builder,
Open Source (eligible for one track prize + one mini-challenge prize).

---

## Product feedback (per Amazon program)

1. **MCP spec cadence:** four spec versions shipped inside ~14 months (2024-11-05 →
   2025-03-26 → 2025-06-18 → 2025-11-25). Recommend an LTS marker and explicit
   deprecation windows so SDK adopters (us) don't chase breaking transport changes.

2. **`@modelcontextprotocol/sdk`:** `registerTool(name, opts, cb)`, zod v4 schemas,
   and the Streamable HTTP transport are excellent and got us to a working server in an
   evening. Gap: first-class **auth** (OAuth) still feels bolt-on; a documented
   `sessionIdGenerator` collision policy and a health/`sse` negotiation helper would
   remove guessing.

3. **Amazon Bedrock (Converse + tool use):** tool-calling support is strong. Two asks:
   (a) an API to **list available model/inference-profile IDs** — in 2026, on-demand
   Claude access silently requires inference-profile model IDs (`us.*-v1:0`) that aren't
   discoverable from the docs alone; (b) surface **tool-description requirements** as
   clear validation errors — empty descriptions are rejected, but not obviously.

4. **`app.get("/{*splat}")` note** belongs below in friction, not feedback.

---

## Friction log (judging bonus)

| # | Friction | Workaround | Severity |
|---|---|---|---|
| 1 | MCP SDK `StreamableHTTPServerTransport.handleRequest` signature and session plumbing changed across recent versions; docs lag. | Pinned SDK 1.30.0, wrapped transport in one `handleMcpRequest` adapter. | Medium |
| 2 | SDK `registerTool` validates `inputSchema` as `ZodType`; zod v4 shape mismatches silently no-op tool registration in some aliases. | Strict `z.object(...)` schemas; verified tool count in smoke test. | Low |
| 3 | Express 5 wildcard route `app.get("*")` throws → must use `app.get("/{*splat}")`. | Used named splat route for SPA fallback. | Medium |
| 4 | Bedrock Converse rejects tools whose `description` field is empty; MCP examples ship schemas without `description`. | Sanitizer guarantees non-empty descriptions. | Medium |
| 5 | No state locking: two concurrent MCP sessions can race on single-file `data/household.json`. | Single-process org; atomic-ish write via buffer + rename. | Low |
| 6 | Windows native `curl.exe` + PowerShell mangles inline JSON bodies for SSE POSTs. | Write body to temp file, send `--data-binary @file`. | Low (client) |
| 7 | SSE + Express: responses need `flushHeaders()` early or the browser buffers the first event. | Explicit flush before first streamed write. | Low |

---

## $150 AWS credit form (short README)

Hearth's runtime costs are minimal: one Bedrock model call per demo turn (a handful of
`hearth-deterministic` local fallbacks for offline). If credits are awarded, they fund
live-session evaluation + a multi-household stress test. AWS services actually used:
**Amazon Bedrock** (Converse, tool calling, inference profile
`us.anthropic.claude-haiku-4-5-20251001-v1:0`).

Legal/checklist on the form: private repo → be sure to make **public** with license shown
in **About**; list **track + mini-challenge**; keep demo **under 3 minutes**.

## Deadlines

- $150 AWS credit request: **Oct 21, 2026, 12:00pm PT**
- Devpost submission: **Oct 23, 2026** (page: 10pm GMT+3; rules: 12:00pm PT)