import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../..");

export const config = {
  port: parseInt(process.env.PORT ?? "4000", 10),
  stateFile: resolve(process.env.HEARTH_STATE_FILE ?? "data/household.json"),
  llmProvider: (process.env.HEARTH_LLM_PROVIDER ?? "auto") as "auto" | "bedrock" | "local",
  bedrockModel: process.env.HEARTH_BEDROCK_MODEL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  bedrockRegion: process.env.HEARTH_AWS_REGION ?? "us-east-1",
  dinnerTime: process.env.HEARTH_DINNER_TIME ?? "19:00",
  /** Replace the agent system prompt wholesale (HEARTH_SYSTEM_PROMPT) … */
  systemPrompt: process.env.HEARTH_SYSTEM_PROMPT ?? "",
  /** … or point it at a markdown/txt file (HEARTH_SYSTEM_PROMPT_FILE). */
  systemPromptFile: process.env.HEARTH_SYSTEM_PROMPT_FILE ?? "",
  root: ROOT,
  webDist: resolve(ROOT, "web/dist"),
};

/** The system prompt the agent runs with: env override > file > built-in default. */
export function resolveSystemPrompt(): string | undefined {
  if (config.systemPrompt) return config.systemPrompt;
  if (config.systemPromptFile) {
    const path = resolve(ROOT, config.systemPromptFile);
    if (existsSync(path)) return readFileSync(path, "utf8");
    console.warn(`[hearth] HEARTH_SYSTEM_PROMPT_FILE not found: ${path}`);
  }
  return undefined;
}

export function assertExists(dir: string, msg: string): string {
  if (!existsSync(dir)) throw new Error(`${msg}: ${dir}`);
  return dir;
}