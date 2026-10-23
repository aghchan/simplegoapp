// `npm run trail-names`: rewrites config/trail-names.json from OpenStreetMap. One Overpass query
// per mountain, in turn, as Overpass asks. Each good answer is saved in scripts/overpass/, and a
// mountain whose query fails or comes back unusable falls back on its saved answer, so the lists
// survive Overpass being down. A mountain with neither fails the run, which then writes nothing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  IKON_RESORTS,
  OVERPASS_URL,
  SOURCE,
  chooseAnswer,
  osmAsOf,
  overpassQuery,
  runsOf,
  slugOf,
  trailNameLists,
  type Fetched,
  type Run,
} from "./trail-names-lib.ts";

const OUT = new URL("../../config/trail-names.json", import.meta.url);
const SAVED = new URL("../overpass/", import.meta.url);
const RETRY_MS = [15_000, 60_000];
// The query's own timeout is 120 s; past that, Overpass is not answering.
const TIMEOUT_MS = 180_000;

async function ask(query: string): Promise<Fetched> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "user-agent": "basetobase-trail-names (github.com/aghchan/simplegoapp)" },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      return { error: `Overpass unreachable: ${reasonOf(error)}` };
    }
    // Busy (429) or timed out (504): Overpass asks callers to wait and try again.
    const wait = RETRY_MS[attempt];
    if ((res.status === 429 || res.status === 504) && wait !== undefined) {
      console.log(`  Overpass answered ${res.status}; trying again in ${wait / 1000} s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    const text = await res.text().catch(() => "");
    return res.ok ? { text } : { error: `Overpass answered ${res.status}` };
  }
}

// fetch's own message is only "fetch failed"; the cause says what failed (ENOTFOUND, a timeout).
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const detail = cause?.code ?? cause?.message;
  return typeof detail === "string" ? `${error.message} (${detail})` : error.message;
}

function saved(file: URL): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

mkdirSync(SAVED, { recursive: true });
const byResort: { resort: string; runs: Run[] }[] = [];
const resorts: { name: string; runs: number; osmAsOf: string | null }[] = [];
const failures: string[] = [];
const fellBack: string[] = [];
for (const resort of IKON_RESORTS) {
  const file = new URL(`${slugOf(resort.name)}.json`, SAVED);
  const chosen = chooseAnswer(await ask(overpassQuery(resort)), saved(file));
  if ("error" in chosen) {
    console.error(`${resort.name}: ${chosen.error}`);
    failures.push(resort.name);
    continue;
  }
  if (chosen.from === "fresh") writeFileSync(file, chosen.text);
  else fellBack.push(resort.name);
  const runs = runsOf(chosen.body);
  const count = (rating: string) => runs.filter((run) => run.rating === rating).length;
  console.log(
    `${resort.name}: ${runs.length} runs (${count("green")} green, ${count("blue")} blue, ` +
      `${count("black")} black, ${count("double_black")} double black), ${chosen.from}`,
  );
  if (chosen.warning) console.warn(`  ${chosen.warning}`);
  byResort.push({ resort: resort.name, runs });
  resorts.push({ name: resort.name, runs: runs.length, osmAsOf: osmAsOf(chosen.body) ?? null });
}

if (failures.length > 0) {
  console.error(`No names for ${failures.join(", ")}; config/trail-names.json is unchanged.`);
  process.exit(1);
}
const trailNames = trailNameLists(byResort);
const empty = Object.entries(trailNames).filter(([, names]) => names.length === 0);
if (empty.length > 0) {
  const ratings = empty.map(([rating]) => rating).join(", ");
  console.error(`No names for ${ratings}; config/trail-names.json is unchanged.`);
  process.exit(1);
}
writeFileSync(OUT, `${JSON.stringify({ source: SOURCE, resorts, trailNames }, null, 2)}\n`);
const total = Object.values(trailNames).reduce((sum, names) => sum + names.length, 0);
console.log(`Wrote ${total} names to config/trail-names.json.`);
if (fellBack.length > 0) console.warn(`From saved answers: ${fellBack.join(", ")}.`);
