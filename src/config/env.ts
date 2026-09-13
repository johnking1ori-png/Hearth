import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../..");

export const config = {
  port: parseInt(process.env.PORT ?? "4000", 10),
  stateFile: resolve(process.env.HEARTH_STATE_FILE ?? "data/household.json"),
  llmProvider: (process.env.HEARTH_LLM_PROVIDER ?? "auto") as "auto" | "bedrock" | "local",
  bedrockModel: process.env.HEARTH_BEDROCK_MODEL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  bedrockRegion: process.env.HEARTH_AWS_REGION ?? "us-east-1",
  dinnerTime: process.env.HEARTH_DINNER_TIME ?? "19:00",
  root: ROOT,
  webDist: resolve(ROOT, "web/dist"),
};

export function assertExists(dir: string, msg: string): string {
  if (!existsSync(dir)) throw new Error(`${msg}: ${dir}`);
  return dir;
}