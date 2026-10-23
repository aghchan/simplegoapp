import { describe, expect, it } from "vitest";
import {
  IKON_RESORTS,
  answerProblem,
  chooseAnswer,
  osmAsOf,
  overpassQuery,
  ratingOf,
  runsOf,
  slugOf,
  trailNameLists,
} from "../src/trail-names-lib.ts";

const way = (tags: Record<string, string>) => ({ type: "way", id: 1, tags });

describe("ratingOf", () => {
  it("files OpenStreetMap's difficulties under the trail ratings", () => {
    expect(ratingOf("novice")).toBe("green");
    expect(ratingOf("easy")).toBe("green");
    expect(ratingOf("intermediate")).toBe("blue");
    expect(ratingOf("advanced")).toBe("black");
    expect(ratingOf("expert")).toBe("double_black");
    expect(ratingOf("freeride")).toBe("double_black");
    expect(ratingOf(" Extreme ")).toBe("double_black");
  });

  it("leaves out a difficulty it does not know, and a missing one", () => {
    expect(ratingOf("extreme;freeride")).toBeUndefined();
    expect(ratingOf(undefined)).toBeUndefined();
  });
});

describe("overpassQuery", () => {
  it("asks for the downhill runs inside the resort's ski area and box", () => {
    const query = overpassQuery({
      name: "Alta",
      area: "Alta",
      bbox: [40.56, -111.66, 40.6, -111.6],
    });
    expect(query).toContain('area["landuse"="winter_sports"]["name"~"Alta",i]->.resort;');
    expect(query).toContain(
      'way["piste:type"="downhill"](area.resort)(40.56,-111.66,40.6,-111.6);',
    );
    expect(query).toContain(
      'relation["route"="piste"]["piste:type"="downhill"](area.resort)(40.56,-111.66,40.6,-111.6);',
    );
    expect(query).toMatch(/^\[out:json\]/);
  });

  it("covers every Ikon mountain in California and Utah once, each with a sane box", () => {
    expect(new Set(IKON_RESORTS.map((resort) => resort.name)).size).toBe(12);
    for (const { bbox } of IKON_RESORTS) {
      const [south, west, north, east] = bbox;
      expect(south).toBeLessThan(north);
      expect(west).toBeLessThan(east);
    }
  });
});

describe("runsOf", () => {
  it("keeps each named, rated run once, preferring piste:name", () => {
    const body = {
      elements: [
        way({ name: "Siberia", "piste:difficulty": "advanced" }),
        way({ name: "Siberia", "piste:difficulty": "advanced" }),
        way({ name: "Road 3", "piste:name": "Mountain  Run ", "piste:difficulty": "easy" }),
        { type: "relation", id: 2, tags: { name: "KT-22", "piste:difficulty": "expert" } },
      ],
    };
    expect(runsOf(body)).toEqual([
      { name: "Siberia", rating: "black" },
      { name: "Mountain Run", rating: "green" },
      { name: "KT-22", rating: "double_black" },
    ]);
  });

  it("keeps a name under each rating it is drawn with", () => {
    const body = {
      elements: [
        way({ name: "Chute", "piste:difficulty": "advanced" }),
        way({ name: "chute", "piste:difficulty": "advanced" }),
        way({ name: "Chute", "piste:difficulty": "expert" }),
      ],
    };
    expect(runsOf(body)).toEqual([
      { name: "Chute", rating: "black" },
      { name: "Chute", rating: "double_black" },
    ]);
  });

  it("drops unnamed, unrated and nameless-in-letters runs", () => {
    const body = {
      elements: [
        way({ "piste:difficulty": "easy" }),
        way({ name: "Cat Track" }),
        way({ name: "Cliffs", "piste:difficulty": "unknown" }),
        way({ name: "  ", "piste:difficulty": "easy" }),
        way({ name: "12", "piste:difficulty": "easy" }),
        { type: "node", id: 3 },
      ],
    };
    expect(runsOf(body)).toEqual([]);
  });

  it("finds nothing in an answer that is not Overpass's", () => {
    expect(runsOf(null)).toEqual([]);
    expect(runsOf({ remark: "runtime error" })).toEqual([]);
  });
});

describe("trailNameLists", () => {
  const run = (name: string, rating: "green" | "blue" | "black" | "double_black" = "green") => ({
    name,
    rating,
  });

  it("takes each rating's names from the resorts in turn, alphabetically within each", () => {
    const lists = trailNameLists([
      {
        resort: "Alta",
        runs: [run("Mambo"), run("Crooked Mile"), run("High Rustler", "double_black")],
      },
      { resort: "Snowbird", runs: [run("Chickadee"), run("Big Emma"), run("Bassackwards")] },
      { resort: "Brighton", runs: [run("Lost Maid")] },
    ]);
    expect(lists.green).toEqual([
      "Crooked Mile",
      "Bassackwards",
      "Lost Maid",
      "Mambo",
      "Big Emma",
      "Chickadee",
    ]);
    expect(lists.double_black).toEqual(["High Rustler"]);
    expect(lists.blue).toEqual([]);
  });

  it("gives a name two resorts share once", () => {
    const lists = trailNameLists([
      { resort: "Alta", runs: [run("Baldy Chutes", "double_black")] },
      {
        resort: "Snowbird",
        runs: [run("baldy chutes", "double_black"), run("Great Scott", "double_black")],
      },
    ]);
    expect(lists.double_black).toEqual(["Baldy Chutes", "Great Scott"]);
  });
});

// An answer as Overpass sends one: its header, then the runs.
function answer(runs: Record<string, string>[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 0.6,
    generator: "Overpass API",
    osm3s: { timestamp_osm_base: "2026-10-23T18:00:00Z", copyright: "ODbL" },
    elements: runs.map(way),
    ...extra,
  });
}
const alta = answer([{ name: "Mambo", "piste:difficulty": "easy" }]);
const altaLater = answer([{ name: "Sugarloaf", "piste:difficulty": "intermediate" }]);

describe("slugOf", () => {
  it("names each mountain's saved answer plainly, and differently", () => {
    expect(slugOf("Palisades Tahoe")).toBe("palisades-tahoe");
    expect(slugOf("Snowbird")).toBe("snowbird");
    expect(new Set(IKON_RESORTS.map((resort) => slugOf(resort.name))).size).toBe(12);
  });
});

describe("osmAsOf", () => {
  it("reads when OpenStreetMap's data was as served", () => {
    expect(osmAsOf(JSON.parse(alta))).toBe("2026-10-23T18:00:00Z");
    expect(osmAsOf({ elements: [] })).toBeUndefined();
    expect(osmAsOf(null)).toBeUndefined();
  });
});

describe("answerProblem", () => {
  it("passes an answer with named runs", () => expect(answerProblem(alta)).toBeUndefined());

  it.each([
    ["text that is not JSON", "<html>502 Bad Gateway</html>", "not JSON"],
    ["JSON that is not an answer", '{"error":"busy"}', "not an Overpass answer"],
    [
      "a query that ran out of time, though answered 200",
      answer([{ name: "Mambo", "piste:difficulty": "easy" }], {
        remark: 'runtime error: Query timed out in "query" at line 3 after 121 seconds.',
      }),
      "Overpass: runtime error: Query timed out",
    ],
    ["an answer without a named run", answer([{ name: "Cat Track" }]), "no named runs"],
  ])("refuses %s", (_name, text, why) => expect(answerProblem(text)).toContain(why));
});

describe("chooseAnswer", () => {
  it("takes a good fresh answer, over the saved one", () => {
    expect(chooseAnswer({ text: altaLater }, alta)).toEqual({
      from: "fresh",
      text: altaLater,
      body: JSON.parse(altaLater),
    });
  });

  it("falls back on the saved answer while Overpass is down, saying so and how old it is", () => {
    const chosen = chooseAnswer({ error: "Overpass unreachable: fetch failed" }, alta);
    expect(chosen).toEqual({
      from: "saved",
      text: alta,
      body: JSON.parse(alta),
      warning:
        "Overpass unreachable: fetch failed; using the saved answer, as of 2026-10-23T18:00:00Z",
    });
  });

  it("keeps the saved answer over a fresh one that cannot be used", () => {
    const timedOut = answer([], { remark: "runtime error: Query run out of memory" });
    expect(chooseAnswer({ text: timedOut }, alta)).toMatchObject({ from: "saved", text: alta });
    const empty = answer([{ name: "Cat Track" }]);
    expect(chooseAnswer({ text: empty }, alta)).toMatchObject({
      from: "saved",
      warning: expect.stringContaining("no named runs"),
    });
  });

  it("fails with nothing saved, or nothing usable saved", () => {
    expect(chooseAnswer({ error: "Overpass answered 503" }, undefined)).toEqual({
      error: "Overpass answered 503, and no saved answer to fall back on: none is saved",
    });
    expect(chooseAnswer({ error: "Overpass answered 503" }, "{")).toEqual({
      error: "Overpass answered 503, and no saved answer to fall back on: not JSON",
    });
  });
});
