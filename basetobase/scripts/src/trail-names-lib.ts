// The run names (config/trail-names.json): every named downhill run at the Ikon Pass mountains in
// California and Utah, from OpenStreetMap, filed by the run's own difficulty. trail-names.ts
// fetches and keeps each mountain's last good answer (scripts/overpass/); this file decides.
import type { Rating } from "../../shared/src/config.ts";

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const SOURCE =
  "OpenStreetMap contributors (ODbL): named downhill runs with a piste:difficulty at the Ikon " +
  "Pass mountains in California and Utah";

export interface Resort {
  name: string;
  // Matches the name of the resort's ski area (landuse=winter_sports) in OpenStreetMap.
  area: string;
  // south, west, north, east: keeps a same-named area elsewhere, and a neighbour, out.
  bbox: [number, number, number, number];
}

// Ikon Pass 2026-27, per Ski Utah's Ikon guide and Ikon's own list.
export const IKON_RESORTS: Resort[] = [
  {
    name: "Palisades Tahoe",
    area: "Palisades|Squaw|Alpine Meadows",
    bbox: [39.13, -120.32, 39.22, -120.2],
  },
  { name: "Mammoth Mountain", area: "Mammoth", bbox: [37.6, -119.08, 37.67, -118.98] },
  { name: "June Mountain", area: "June", bbox: [37.74, -119.11, 37.79, -119.05] },
  { name: "Bear Mountain", area: "Bear Mountain", bbox: [34.2, -116.9, 34.24, -116.85] },
  { name: "Snow Summit", area: "Snow Summit", bbox: [34.21, -116.91, 34.24, -116.87] },
  { name: "Snow Valley", area: "Snow Valley", bbox: [34.2, -117.06, 34.24, -117.02] },
  { name: "Alta", area: "Alta", bbox: [40.56, -111.66, 40.6, -111.6] },
  { name: "Snowbird", area: "Snowbird", bbox: [40.55, -111.69, 40.6, -111.63] },
  { name: "Brighton", area: "Brighton", bbox: [40.58, -111.6, 40.62, -111.56] },
  { name: "Solitude", area: "Solitude", bbox: [40.6, -111.62, 40.64, -111.57] },
  { name: "Deer Valley", area: "Deer Valley", bbox: [40.57, -111.53, 40.68, -111.39] },
  { name: "Snowbasin", area: "Snowbasin", bbox: [41.18, -111.9, 41.24, -111.83] },
];

const RATINGS: Rating[] = ["green", "blue", "black", "double_black"];

// OpenStreetMap's piste:difficulty, onto the trail ratings. Anything else is left out.
const RATING_OF: Record<string, Rating> = {
  novice: "green",
  easy: "green",
  intermediate: "blue",
  advanced: "black",
  expert: "double_black",
  freeride: "double_black",
  extreme: "double_black",
};

export function ratingOf(difficulty: string | undefined): Rating | undefined {
  return difficulty === undefined ? undefined : RATING_OF[difficulty.trim().toLowerCase()];
}

// Runs drawn as ways and as piste route relations, named by either tag.
export function overpassQuery(resort: Resort): string {
  const [s, w, n, e] = resort.bbox;
  const area = JSON.stringify(resort.area);
  return [
    "[out:json][timeout:120];",
    `area["landuse"="winter_sports"]["name"~${area},i]->.resort;`,
    "(",
    `  way["piste:type"="downhill"](area.resort)(${s},${w},${n},${e});`,
    `  relation["route"="piste"]["piste:type"="downhill"](area.resort)(${s},${w},${n},${e});`,
    ");",
    "out tags;",
  ].join("\n");
}

export interface Run {
  name: string;
  rating: Rating;
}

// An Overpass answer's named, rated runs. A run drawn in pieces comes back once per rating.
export function runsOf(body: unknown): Run[] {
  const elements = (body as { elements?: unknown })?.elements;
  if (!Array.isArray(elements)) return [];
  const seen = new Set<string>();
  return elements.flatMap((element: { tags?: Record<string, unknown> }) => {
    const tags = element?.tags ?? {};
    const raw = tags["piste:name"] ?? tags.name;
    const difficulty = tags["piste:difficulty"];
    const rating = ratingOf(typeof difficulty === "string" ? difficulty : undefined);
    if (typeof raw !== "string" || !rating) return [];
    const name = raw.replace(/\s+/g, " ").trim();
    const key = `${rating}:${name.toLowerCase()}`;
    // "12" names nothing a reader would recognise.
    if (!/\p{L}/u.test(name) || seen.has(key)) return [];
    seen.add(key);
    return [{ name, rating }];
  });
}

// Each rating's names, one resort after another in turn, so consecutive runs come from different
// mountains. Alphabetical within a resort, so a rerun diffs cleanly. A name two resorts share
// appears once per rating.
export function trailNameLists(
  byResort: { resort: string; runs: Run[] }[],
): Record<Rating, string[]> {
  const lists = {} as Record<Rating, string[]>;
  for (const rating of RATINGS) {
    const queues = byResort.map(({ runs }) =>
      runs
        .filter((run) => run.rating === rating)
        .map((run) => run.name)
        .sort((a, b) => a.localeCompare(b)),
    );
    const seen = new Set<string>();
    const names: string[] = [];
    for (let i = 0; queues.some((queue) => i < queue.length); i++) {
      for (const queue of queues) {
        const name = queue[i];
        if (name === undefined || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        names.push(name);
      }
    }
    lists[rating] = names;
  }
  return lists;
}

// A mountain's saved answer: scripts/overpass/<slug>.json.
export function slugOf(resort: string): string {
  return resort
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// When OpenStreetMap's data was as Overpass served it, from the answer's own header.
export function osmAsOf(body: unknown): string | undefined {
  const osm3s = (body as { osm3s?: { timestamp_osm_base?: unknown } } | null)?.osm3s;
  const at = osm3s?.timestamp_osm_base;
  return typeof at === "string" && at !== "" ? at : undefined;
}

// Why an answer cannot be used, or undefined when it can. A 200 can still carry a failed query:
// Overpass reports a timeout or running out of memory in `remark`, beside what it had got to.
export function answerProblem(text: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "not JSON";
  }
  if (!Array.isArray((body as { elements?: unknown } | null)?.elements)) {
    return "not an Overpass answer";
  }
  const remark = (body as { remark?: unknown }).remark;
  if (typeof remark === "string" && /error/i.test(remark)) return `Overpass: ${remark}`;
  if (runsOf(body).length === 0) {
    return "no named runs (check its area and box in trail-names-lib.ts)";
  }
  return undefined;
}

// What asking Overpass came to: its answer, or why there was none.
export type Fetched = { text: string } | { error: string };

export type Chosen =
  | { from: "fresh" | "saved"; text: string; body: unknown; warning?: string }
  | { error: string };

// The fresh answer when it is good, else the one saved from an earlier run, so a mountain keeps
// its names while Overpass is down. An unusable answer never replaces a saved one.
export function chooseAnswer(fresh: Fetched, saved: string | undefined): Chosen {
  const why = "error" in fresh ? fresh.error : answerProblem(fresh.text);
  if (why === undefined && "text" in fresh) {
    return { from: "fresh", text: fresh.text, body: JSON.parse(fresh.text) };
  }
  const savedWhy = saved === undefined ? "none is saved" : answerProblem(saved);
  if (saved === undefined || savedWhy !== undefined) {
    return { error: `${why}, and no saved answer to fall back on: ${savedWhy}` };
  }
  const body: unknown = JSON.parse(saved);
  const asOf = osmAsOf(body) ?? "an unknown date";
  const warning = `${why}; using the saved answer, as of ${asOf}`;
  return { from: "saved", text: saved, body, warning };
}
