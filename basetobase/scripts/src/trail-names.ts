// `npm run trail-names`: rewrites config/trail-names.json from OpenStreetMap. One Overpass query
// per mountain, in turn and each in a free slot, as Overpass asks. Each good answer is saved in
// scripts/overpass/, and a mountain whose query fails or comes back unusable falls back on its
// saved answer, so the lists survive Overpass being down. A mountain with neither fails the run,
// which then writes nothing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  IKON_RESORTS,
  OVERPASS_STATUS_URL,
  OVERPASS_URL,
  SOURCE,
  chooseAnswer,
  osmAsOf,
  overloaded,
  overpassQuery,
  runsOf,
  slotWaitMs,
  slugOf,
  trailNameLists,
  type Fetched,
  type Run,
} from "./trail-names-lib.ts";

const OUT = new URL("../../config/trail-names.json", import.meta.url);
const SAVED = new URL("../overpass/", import.meta.url);
const USER_AGENT = "basetobase-trail-names (github.com/aghchan/simplegoapp)";
const ATTEMPTS = 5;
// Between tries, at the least: Overpass's cooldowns run from seconds to minutes.
const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000];
// Past this, Overpass is as good as down, and the saved answer stands in.
const SLOT_WAIT_MAX_MS = 300_000;
// The query's own timeout is 120 s; past that, Overpass is not answering.
const TIMEOUT_MS = 180_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function statusPage(): Promise<string | undefined> {
  try {
    const res = await fetch(OVERPASS_STATUS_URL, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

// Asks only once Overpass has a slot free for this caller: asking sooner earns a 429.
async function waitForSlot(minimumMs: number): Promise<void> {
  const status = await statusPage();
  const slot = status === undefined ? undefined : slotWaitMs(status);
  const wait = Math.min(Math.max(minimumMs, slot ?? 0), SLOT_WAIT_MAX_MS);
  if (wait === 0) return;
  console.log(`  waiting ${Math.ceil(wait / 1000)} s for an Overpass slot`);
  await sleep(wait);
}

async function ask(query: string): Promise<Fetched> {
  let busy = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    await waitForSlot(attempt === 0 ? 0 : BACKOFF_MS[attempt - 1]!);
    let res: Response;
    try {
      res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "user-agent": USER_AGENT },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      return { error: `Overpass unreachable: ${reasonOf(error)}` };
    }
    const text = await res.text().catch(() => "");
    // Rate limited (429), overloaded (504), or a query it gave up on: a later try may get through.
    if (res.status === 429 || res.status === 504 || (res.ok && overloaded(text))) {
      busy = res.ok ? "Overpass ran out of time or memory" : `Overpass answered ${res.status}`;
      if (attempt < ATTEMPTS - 1) console.log(`  ${busy}; trying again`);
      continue;
    }
    return res.ok ? { text } : { error: `Overpass answered ${res.status}` };
  }
  return { error: `${busy} on all ${ATTEMPTS} tries` };
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
