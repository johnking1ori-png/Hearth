import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { seedState } from "../state/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const example = resolve(ROOT, "data/household.example.json");
const live = resolve(ROOT, "data/household.json");

mkdirSync(dirname(example), { recursive: true });
writeFileSync(example, JSON.stringify(seedState(), null, 2), "utf-8");

if (!existsSync(live)) {
  copyFileSync(example, live);
  console.log("Created data/household.json");
}
console.log("Seeded data/household.example.json");
console.log(`Household: ${seedState().householdName} (${seedState().family.length} members, ${seedState().recipes.length} recipes)`);