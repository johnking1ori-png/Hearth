import { useCallback, useEffect, useRef, useState } from "react";
import {
  streamChat,
  fetchHousehold,
  fetchHealth,
  resetHousehold,
  type Message,
  type ChatEvent,
  type ToolCallTrace,
  type Household,
} from "./api";

const SESSION_ID = "household-demo";

const SUGGESTIONS = [
  "Plan next week's dinners. We're vegetarian on Tuesdays and Thursdays, and Alex is dairy allergic.",
  "What do we need to pick up from the store this week?",
  "What's for dinner tonight and who's cooking? Start a cooking session.",
  "Plan tonight's evening routine so dinner lands at 7pm on the dot.",
];

const TOOL_LABELS: Record<string, string> = {
  "household.get_status": "Read household status",
  "family.set_preferences": "Update family preferences",
  "pantry.list": "Check pantry",
  "pantry.add": "Add to pantry",
  "pantry.update": "Update pantry item",
  "pantry.remove": "Remove from pantry",
  "recipe.list": "Browse recipe library",
  "recipe.search": "Search recipes",
  "recipe.get": "Open a recipe",
  "mealplan.list": "Show meal plan",
  "mealplan.generate": "Generate meal plan",
  "mealplan.set": "Override meal plan",
  "shopping.list": "Read shopping list",
  "shopping.add": "Add shopping item",
  "shopping.mark": "Mark item bought",
  "shopping.sync_from_mealplan": "Sync list from meal plan",
  "cooking.start": "Start cooking",
  "cooking.status": "Cooking status",
  "cooking.advance": "Advance step",
  "routine.plan_evening": "Plan evening routine",
  "routine.get": "Read evening routine",
  "routine.complete_step": "Complete routine step",
  "orchestrate.task": "Orchestrate task",
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [household, setHousehold] = useState<Household | null>(null);
  const [health, setHealth] = useState<{ bedrock: boolean; model: string; dinnerTime: string } | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState<ToolCallTrace[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);

  const refreshHousehold = useCallback(async () => {
    try {
      setHousehold(await fetchHousehold());
    } catch {
      /* server not up yet */
    }
  }, []);

  useEffect(() => {
    fetchHealth().then(setHealth).catch(() => {});
    refreshHousehold();
  }, [refreshHousehold]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, trace]);

  const send = useCallback(
    async (text?: string) => {
      const message = (text ?? input).trim();
      if (!message || busy) return;
      setInput("");
      setBusy(true);
      setTrace([]);
      setMessages((m) => [...m, { role: "user", text: message }]);

      const traces: ToolCallTrace[] = [];
      try {
        await streamChat(message, SESSION_ID, (ev: ChatEvent) => {
          if (ev.type === "tool_start" && ev.name) {
            traces.push({ name: ev.name, args: ev.args ?? {}, result: "", isError: false, durationMs: 0 });
            setTrace([...traces]);
          } else if (ev.type === "tool_result" && ev.name) {
            const last = traces[traces.length - 1];
            if (last && last.name === ev.name) {
              last.result = ev.content ?? "";
              last.isError = ev.isError ?? false;
              last.durationMs = ev.durationMs ?? 0;
              setTrace([...traces]);
            }
          }
        }).then((done) => {
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              text:
                done.type === "error"
                  ? `⚠️ ${done.content ?? "Something went wrong on the server."}`
                  : done.content ?? "Done.",
              provider: done.provider ?? "unknown",
              model: done.model ?? "",
              toolCalls: traces.length,
              iterations: done.iterations ?? 1,
              durationMs: done.durationMs ?? 0,
            },
          ]);
        });
      } catch (err) {
        setMessages((m) => [
          ...m,
          { role: "assistant", text: `Connection error: ${err instanceof Error ? err.message : String(err)}`, provider: "", model: "", toolCalls: 0, iterations: 0, durationMs: 0 },
        ]);
      } finally {
        setBusy(false);
        refreshHousehold();
      }
    },
    [input, busy, refreshHousehold],
  );

  const onReset = useCallback(async () => {
    await resetHousehold();
    setMessages([]);
    setTrace([]);
    await refreshHousehold();
  }, [refreshHousehold]);

  const providerLabel = health?.bedrock ? "Amazon Bedrock · Claude" : "Local intent router (no AWS keys)";
  const modelShort = health?.model ? health.model.split("/").pop() : "";

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">
          <div className="logo-mark">🔥</div>
          <div>
            <div>Hearth</div>
            <div className="tagline">Household Task Orchestrator · Alexa+ via MCP</div>
          </div>
        </div>
        <div className="badge">
          {health && <span className={`pill ${health.bedrock ? "bedrock" : ""}`}>{providerLabel}</span>}
          {health && <span className="pill">{modelShort}</span>}
          <span className="pill">dinner @ {health?.dinnerTime ?? "19:00"}</span>
          <button className="btn" onClick={onReset}>
            Reset demo
          </button>
        </div>
      </header>

      <div className="main">
        <section className="col-chat">
          <div className="thread" ref={threadRef}>
            {messages.length === 0 && (
              <div className="msg assistant">
                Hi, I'm Hearth 🔥 — the household task orchestrator living inside this MCP server for Alexa+.
                {"\n\n"}I plan the week's dinners around your household's diets, sync your shopping list with
                what's actually in the pantry, run step-by-step cooking sessions, and time the whole evening
                so dinner lands on the table at {health?.dinnerTime ?? "19:00"}.
                {"\n\n"}Everything I tell you is grounded in real household state — watch the tool trace as I work.
              </div>
            )}
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="msg user">
                  {m.text}
                </div>
              ) : (
                <div key={i} className="msg assistant">
                  {m.text}
                  <div className="msg-meta">
                    {m.provider && <>engine: {m.provider} · </>}
                    {m.toolCalls > 0 && <>{m.toolCalls} tool call{m.toolCalls > 1 ? "s" : ""} · </>}
                    {m.iterations} iterations · {(m.durationMs / 1000).toFixed(1)}s
                  </div>
                </div>
              ),
            )}
            {busy && (
              <div className="msg assistant">
                <span className="spinner" /> Hearth is orchestrating…
              </div>
            )}
          </div>

          {trace.length > 0 && (
            <div className="trace">
              <div className="trace-title">Agent trace · {trace.length} tool calls over MCP</div>
              {trace.map((t, i) => (
                <div key={i} className={`trace-step ${t.isError ? "error" : t.result ? "ok" : ""}`}>
                  <span className="name">▸ {t.name}</span>{" "}
                  <span className="args">{Object.keys(t.args).length ? JSON.stringify(t.args) : "()"}</span>
                  {t.durationMs > 0 && <span className="duration">{t.durationMs}ms</span>}
                  {t.result && <div className="result">{t.result}</div>}
                </div>
              ))}
            </div>
          )}

          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggestion" disabled={busy} onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Hearth to orchestrate your household…"
              disabled={busy}
            />
            <button type="submit" disabled={busy || !input.trim()}>
              Send
            </button>
          </form>
        </section>

        <aside className="col-dash">
          <Dashboard household={household} />
          <div className="footer-note">
            Hearth · MCP server (Streamable HTTP) · demo state lives in data/household.json
          </div>
        </aside>
      </div>
    </div>
  );
}

function Dashboard({ household }: { household: Household | null }) {
  if (!household) {
    return (
      <div className="card">
        <div className="empty">Start the Hearth server (npm run dev) to load household state.</div>
      </div>
    );
  }

  const plan = household.mealPlan;

  return (
    <>
      <div className="card">
        <h3>
          The Talents <span className="count">{household.family.map((m) => m.name).join(" · ")}</span>
        </h3>
        {household.family.map((m) => (
          <div key={m.id} className="row">
            <span>
              <span className="r-name">{m.name}</span>{" "}
              <span className="r-sub">
                {m.diet.join(", ") || "no diet"}
                {m.allergies.length ? ` · allergies: ${m.allergies.join(", ")}` : ""}
              </span>
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>
          Meal plan <span className="count">{plan?.days.length ?? 0} nights</span>
        </h3>
        {plan ? (
          <>
            <div className="row">
              <span className="r-sub">
                Week of {plan.weekStart} · generated by {plan.model}
              </span>
            </div>
            {plan.days.map((d) => (
              <div key={d.date} className="row">
                <span>
                  <span className="r-name">{d.dayOfWeek}: {d.dish}</span>
                  {d.notes && <div className="r-sub">{d.notes}</div>}
                </span>
                <span className="r-right">{d.cook}</span>
              </div>
            ))}
          </>
        ) : (
          <div className="empty">No plan yet — ask Hearth to plan the week.</div>
        )}
      </div>

      <div className="card">
        <h3>
          Shopping list <span className="count">{household.shoppingList.length} items</span>
        </h3>
        {household.shoppingList.length ? (
          household.shoppingList.map((i) => (
            <div key={i.id} className={`row ${i.checked ? "checked" : ""}`}>
              <span>
                <span className="r-name">{i.name}</span>{" "}
                <span className="r-sub">
                  {i.quantity}{i.unit && ` ${i.unit}`}{i.source === "plan" ? " · from plan" : ""}
                </span>
              </span>
              <span className="r-right">{i.checked ? "✓ bought" : i.category}</span>
            </div>
          ))
        ) : (
          <div className="empty">Nothing to buy.</div>
        )}
      </div>

      {household.cookingSession && (
        <div className="card">
          <h3>
            Cooking <span className="count">{household.cookingSession.dish}</span>
          </h3>
          <div className="row">
            <span className={`status-pill ${household.cookingSession.status}`}>{household.cookingSession.status}</span>
            <span className="r-right">
              step {household.cookingSession.currentStep}/{household.cookingSession.steps.length}
            </span>
          </div>
          <div className="r-sub" style={{ padding: "6px 0" }}>
            {household.cookingSession.steps[household.cookingSession.currentStep - 1]?.instruction}
          </div>
        </div>
      )}

      {household.routines.length > 0 && (
        <div className="card">
          <h3>
            Evening routine <span className={`status-pill ${household.routines[0].status}`}>{household.routines[0].status}</span>
          </h3>
          {household.routines[0].steps.map((s, i) => (
            <div key={i} className={`step ${s.resolved ? "done" : ""}`}>
              <span className="time">{s.time}</span> {s.task}
            </div>
          ))}
        </div>
      )}
    </>
  );
}