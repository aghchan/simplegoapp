import { describe, expect, it } from "vitest";
import {
  IKON_RESORTS,
  answerAll,
  answerProblem,
  chooseAnswer,
  osmAsOf,
  overloaded,
  overpassQuery,
  ratingOf,
  retryable,
  runsOf,
  slotWaitMs,
  slugOf,
  trailNameLists,
  type Chosen,
  type Fetched,
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

describe("slotWaitMs", () => {
  const status = (...lines: string[]) =>
    [
      "Connected as: 3232235777",
      "Current time: 2026-10-23T18:40:00Z",
      "Announced endpoint: z.overpass-api.de/api/",
      "Rate limit: 2",
      ...lines,
      "Currently running queries (pid, space limit, time limit, start time):",
    ].join("\n");

  it("is 0 while a slot is free", () => {
    expect(slotWaitMs(status("2 slots available now."))).toBe(0);
    expect(
      slotWaitMs(
        status(
          "1 slots available now.",
          "Slot available after: 2026-10-23T18:40:45Z, in 45 seconds.",
        ),
      ),
    ).toBe(0);
  });

  it("waits for the soonest slot while none is free", () => {
    const busy = status(
      "Slot available after: 2026-10-23T18:41:00Z, in 60 seconds.",
      "Slot available after: 2026-10-23T18:40:32Z, in 32 seconds.",
    );
    expect(slotWaitMs(busy)).toBe(32_000);
  });

  it("reads a slot already due as free", () =>
    expect(slotWaitMs(status("Slot available after: 2026-10-23T18:39:58Z, in -2 seconds."))).toBe(
      0,
    ));

  it("says nothing for a page it cannot read", () => {
    expect(slotWaitMs(status("0 slots available now."))).toBeUndefined();
    expect(slotWaitMs("<html>502 Bad Gateway</html>")).toBeUndefined();
  });
});

describe("overloaded", () => {
  it("spots a query Overpass gave up on for time or memory", () => {
    const timedOut = 'runtime error: Query timed out in "query" at line 3 after 121 seconds.';
    expect(overloaded(answer([], { remark: timedOut }))).toBe(true);
    const memory = "runtime error: Query run out of memory using about 2048 MB of RAM.";
    expect(overloaded(answer([], { remark: memory }))).toBe(true);
  });

  it("passes a finished answer, another remark, and what is not JSON", () => {
    expect(overloaded(alta)).toBe(false);
    expect(overloaded(answer([], { remark: "runtime error: syntax error" }))).toBe(false);
    expect(overloaded("<html>")).toBe(false);
  });
});

describe("retryable", () => {
  it("tries again while Overpass is rate limiting, busy or briefly down", () => {
    for (const status of [429, 502, 503, 504]) expect(retryable(status, "")).toBe(true);
    const timedOut = 'runtime error: Query timed out in "query" at line 3 after 121 seconds.';
    expect(retryable(200, answer([], { remark: timedOut }))).toBe(true);
  });

  it("takes a finished answer, and gives up on an error a later try won't fix", () => {
    expect(retryable(200, alta)).toBe(false);
    for (const status of [400, 403, 404, 500]) expect(retryable(status, "")).toBe(false);
  });
});

describe("answerAll", () => {
  const down: Fetched = { error: "Overpass answered 502 on all 5 tries" };

  // Overpass as each mountain sees it: its answers, in the order it is asked.
  function overpass(replies: Record<string, Fetched[]>, savedAnswers: Record<string, string> = {}) {
    const asked: string[] = [];
    const passes: number[] = [];
    const settled: [string, number][] = [];
    const io = {
      ask: async (mountain: string) => {
        asked.push(mountain);
        const reply = replies[mountain]?.shift();
        if (reply === undefined) throw new Error(`${mountain} asked once too often`);
        return reply;
      },
      saved: (mountain: string) => savedAnswers[mountain],
      beforePass: async (pass: number) => void passes.push(pass),
      settled: (mountain: string, _chosen: Chosen, pass: number) =>
        void settled.push([mountain, pass]),
    };
    return { io, asked, passes, settled };
  }
  const sources = (chosen: Chosen[]) => chosen.map((c) => ("from" in c ? c.from : "error"));

  it("asks again, after the others, for a mountain Overpass would not answer", async () => {
    // Nov 2: Deer Valley got 502 on all 5 tries from 20:21 to 20:25; Snowbasin answered at 20:27.
    const { io, asked, passes, settled } = overpass({
      Solitude: [{ text: alta }],
      "Deer Valley": [down, { text: altaLater }],
      Snowbasin: [{ text: alta }],
    });
    const chosen = await answerAll(["Solitude", "Deer Valley", "Snowbasin"], io, 3);
    expect(asked).toEqual(["Solitude", "Deer Valley", "Snowbasin", "Deer Valley"]);
    expect(passes).toEqual([2]);
    expect(settled).toEqual([
      ["Solitude", 1],
      ["Deer Valley", 1],
      ["Snowbasin", 1],
      ["Deer Valley", 2],
    ]);
    expect(sources(chosen)).toEqual(["fresh", "fresh", "fresh"]);
    expect(chosen[1]).toMatchObject({ text: altaLater });
  });

  it("never asks again for a mountain that fell back on its saved answer", async () => {
    const { io, asked, passes } = overpass(
      { Alta: [down], Snowbird: [{ text: alta }] },
      { Alta: alta },
    );
    const chosen = await answerAll(["Alta", "Snowbird"], io, 3);
    expect(asked).toEqual(["Alta", "Snowbird"]);
    expect(passes).toEqual([]);
    expect(sources(chosen)).toEqual(["saved", "fresh"]);
  });

  it("fails a mountain only when every pass came back with nothing", async () => {
    const { io, asked, passes } = overpass({ "Deer Valley": [down, down, down] });
    const chosen = await answerAll(["Deer Valley"], io, 3);
    expect(asked).toEqual(["Deer Valley", "Deer Valley", "Deer Valley"]);
    expect(passes).toEqual([2, 3]);
    expect(chosen[0]).toEqual({
      error:
        "Overpass answered 502 on all 5 tries, and no saved answer to fall back on: none is saved",
    });
  });

  it("keeps the mountains in their order, whichever pass answered", async () => {
    const { io } = overpass({ June: [down, { text: altaLater }], Bear: [{ text: alta }] });
    const chosen = await answerAll(["June", "Bear"], io, 2);
    expect(chosen.map((c) => ("text" in c ? c.text : c.error))).toEqual([altaLater, alta]);
  });
});
