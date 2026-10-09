export interface ChatEvent {
  type: "tool_start" | "tool_result" | "assistant" | "done" | "error";
  name?: string;
  args?: Record<string, unknown>;
  content?: string;
  isError?: boolean;
  durationMs?: number;
  provider?: string;
  model?: string;
  iterations?: number;
  toolCalls?: number;
}

export interface ToolCallTrace {
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface AssistantTurn {
  role: "user";
  text: string;
}

export interface AssistantReply {
  role: "assistant";
  text: string;
  provider: string;
  model: string;
  toolCalls: number;
  iterations: number;
  durationMs: number;
}

export type Message = AssistantTurn | AssistantReply;

export async function streamChat(
  message: string,
  sessionId: string,
  onEvent: (e: ChatEvent) => void,
): Promise<ChatEvent & { kind: "done" | "error" }> {
  const res = await fetch("/v1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`chat failed (${res.status}): ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: (ChatEvent & { kind: "done" | "error" }) | null = null;
  let answer = "";

  for (;;) {
    const { done: readerDone, value } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      const ev = JSON.parse(part.slice(6)) as ChatEvent;
      onEvent(ev);
      if (ev.type === "assistant" && ev.content) answer = ev.content;
      if (ev.type === "done" || ev.type === "error") done = { kind: ev.type, ...ev };
    }
  }
  if (!done) throw new Error("stream ended without completion event");
  if (!done.content && answer && done.kind === "done") done.content = answer;
  return done;
}

export interface Household {
  householdName: string;
  timezone: string;
  family: { id: string; name: string; diet: string[]; favorites: string[]; allergies: string[] }[];
  pantry: { id: string; name: string; category: string; quantity: number; unit: string }[];
  mealPlan: {
    weekStart: string;
    model: string;
    days: { date: string; dayOfWeek: string; dish: string; recipeId?: string; cook?: string; notes?: string }[];
  } | null;
  shoppingList: { id: string; name: string; quantity: number; unit: string; category: string; source: string; checked: boolean }[];
  recipes: { id: string; name: string; prepMinutes: number; diet: string[]; tags?: string[]; category?: string }[];
  cookingSession: {
    id: string;
    dish: string;
    status: string;
    currentStep: number;
    steps: { stepNumber: number; instruction: string; timerMinutes?: number }[];
  } | null;
  routines: {
    id: string;
    date: string;
    title: string;
    status: string;
    steps: { time: string; task: string; detail?: string; resolved: boolean; tool?: string }[];
  }[];
  updatedAt: string;
}

export async function fetchHousehold(): Promise<Household> {
  const res = await fetch("/api/household");
  if (!res.ok) throw new Error(`fetch household failed: ${res.status}`);
  return res.json();
}

export async function fetchHealth(): Promise<{ status: string; household: string; bedrock: boolean; model: string; dinnerTime: string }> {
  const res = await fetch("/health");
  if (!res.ok) throw new Error(`health failed: ${res.status}`);
  return res.json();
}

export async function resetHousehold(): Promise<void> {
  await fetch("/api/reset", { method: "POST" });
}