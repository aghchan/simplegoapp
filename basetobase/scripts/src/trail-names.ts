// `npm run trail-names`: rewrites config/trail-names.json from OpenStreetMap. One Overpass query
// per mountain, in turn, as Overpass asks; a mountain with no named runs fails the whole run, so a
// ski area OpenStreetMap renamed shows up instead of quietly shrinking the lists.
import { writeFileSync } from "node:fs";
import {
  IKON_RESORTS,
  OVERPASS_URL,
  SOURCE,
  overpassQuery,
  runsOf,
  trailNameLists,
  type Run,
} from "./trail-names-lib.ts";

const OUT = new URL("../../config/trail-names.json", import.meta.url);
const RETRY_MS = [15_000, 60_000];

async function fetchRuns(query: string): Promise<Run[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "user-agent": "basetobase-trail-names (github.com/aghchan/simplegoapp)" },
      body: new URLSearchParams({ data: query }),
    });
    // Busy (429) or timed out (504): Overpass asks callers to wait and try again.
    const wait = RETRY_MS[attempt];
    if ((res.status === 429 || res.status === 504) && wait !== undefined) {
      console.log(`  Overpass answered ${res.status}; trying again in ${wait / 1000} s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Overpass answered ${res.status}: ${body}`);
    }
    return runsOf(await res.json());
  }
}

const byResort: { resort: string; runs: Run[] }[] = [];
for (const resort of IKON_RESORTS) {
  const runs = await fetchRuns(overpassQuery(resort));
  const count = (rating: string) => runs.filter((run) => run.rating === rating).length;
  console.log(
    `${resort.name}: ${runs.length} runs (${count("green")} green, ${count("blue")} blue, ` +
      `${count("black")} black, ${count("double_black")} double black)`,
  );
  if (runs.length === 0) {
    console.error(`No named runs for ${resort.name}: check its area and box in trail-names-lib.ts`);
    process.exit(1);
  }
  byResort.push({ resort: resort.name, runs });
}

const trailNames = trailNameLists(byResort);
const empty = Object.entries(trailNames).filter(([, names]) => names.length === 0);
if (empty.length > 0) {
  const ratings = empty.map(([rating]) => rating).join(", ");
  console.error(`No names for ${ratings}; config/trail-names.json is unchanged.`);
  process.exit(1);
}
const resorts = byResort.map(({ resort, runs }) => ({ name: resort, runs: runs.length }));
writeFileSync(OUT, `${JSON.stringify({ source: SOURCE, resorts, trailNames }, null, 2)}\n`);
const total = Object.values(trailNames).reduce((sum, names) => sum + names.length, 0);
console.log(`Wrote ${total} names to config/trail-names.json.`);
