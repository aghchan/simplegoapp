import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../shared/src/config.ts";
import type { AgentSnapshot, LogLine, RunSnapshot } from "../../shared/src/types.ts";
import * as api from "../src/api.ts";
import { Transcript } from "../src/components/Transcript.tsx";
import { defaultStep, RunPage, RunView } from "../src/pages/RunView.tsx";
import type { RunLive } from "../src/useRunLive.ts";
import { agent, FakeWebSocket, JOB_URL, line, makeRun, START, step } from "./fixtures.ts";

const run = makeRun();
const log: LogLine[] = [
  line(1, null, { text: "run created · Red Dog Face" }),
  line(2, "mainline-sweep-0", { text: "app healthy on :8080" }),
  line(3, "granite-chief-sweep-0", { text: "matches the goal" }),
];

function live(over: Partial<RunLive> = {}): RunLive {
  return { run, log, connection: "live", ...over };
}

function withAgents(...agents: AgentSnapshot[]): RunSnapshot {
  return makeRun({ agents });
}

// The sweep is over and the huddle has begun.
function huddleBegun(): RunSnapshot {
  return makeRun({
    steps: run.steps.map((s) => {
      if (s.id === "sweep") {
        return step("sweep", "done", { startedAt: START, finishedAt: START + 9000 });
      }
      if (s.id === "huddle") return step("huddle", "active", { startedAt: START + 9000 });
      return s;
    }),
  });
}

describe("defaultStep", () => {
  const steps = (...statuses: ("done" | "active" | "pending" | "stopped")[]) =>
    makeRun({
      steps: [
        step("lift_line", statuses[0] ?? "pending"),
        step("trail_map", statuses[1] ?? "pending"),
        step("sweep", statuses[2] ?? "pending"),
        step("huddle", statuses[3] ?? "pending"),
      ],
    });

  it("is the first active step", () => {
    expect(defaultStep(steps("done", "done", "active", "pending"))).toBe("sweep");
  });

  it("is the last done step when nothing is active", () => {
    expect(defaultStep(steps("done", "done", "done", "pending"))).toBe("sweep");
  });

  it("is the lift line when nothing has started", () => {
    expect(defaultStep(steps())).toBe("lift_line");
  });

  it("is the step a stopped run halted on", () => {
    expect(defaultStep(steps("done", "done", "stopped", "pending"))).toBe("sweep");
  });
});

describe("RunView", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/runs/r1");
  });

  it("selects the active step and links the Actions job", () => {
    render(<RunView live={live()} />);
    expect(screen.getByRole("heading", { name: /Patrol sweep/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: /Patrol sweep/ })).toHaveTextContent(
      "Independent review",
    );
    const link = screen.getByRole("link", { name: "GitHub Actions job" });
    expect(link).toHaveAttribute("href", run.agents[0]?.jobUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("clicking a patrol card filters the radio log", async () => {
    const user = userEvent.setup();
    render(<RunView live={live()} />);
    await user.click(screen.getByRole("button", { name: /Mainline/ }));
    expect(screen.getByText(/Mainline only/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Mainline/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const items = within(screen.getByRole("region", { name: "Radio log · logs" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("app healthy on :8080");
  });

  it("shows all patrol again from the Show all patrol button", async () => {
    const user = userEvent.setup();
    render(<RunView live={live()} />);
    expect(screen.getByText(/all patrol/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show all patrol" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Mainline/ }));
    await user.click(screen.getByRole("button", { name: "Show all patrol" }));
    expect(screen.getByText(/all patrol/)).toBeVisible();
    expect(screen.queryByText(/Mainline only/)).toBeNull();
    expect(
      screen.getAllByRole("listitem").filter((li) => li.closest("ol[aria-live]")),
    ).toHaveLength(3);
  });

  it("clicking the picked card again clears the filter", async () => {
    const user = userEvent.setup();
    render(<RunView live={live()} />);
    await user.click(screen.getByRole("button", { name: /Mainline/ }));
    await user.click(screen.getByRole("button", { name: /Mainline/ }));
    expect(screen.queryByText(/Mainline only/)).toBeNull();
  });

  it("shows the pull request header", () => {
    render(<RunView live={live()} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "orders: add cancel endpoint",
    );
    expect(screen.getByText("#58")).toBeVisible();
    expect(screen.getByText("Backend run")).toBeVisible();
    expect(screen.getByRole("img", { name: "Black diamond" })).toBeVisible();
    expect(screen.getByText("Red Dog Face")).toBeVisible();
    expect(screen.getByText("claude/orders-cancel → main · head a91f3c2")).toBeVisible();
    const pr = screen.getByRole("link", { name: "View PR on GitHub" });
    expect(pr).toHaveAttribute("href", run.prUrl);
    expect(pr).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("names a run on both panels", () => {
    render(<RunView live={live({ run: makeRun({ panels: ["backend", "frontend"] }) })} />);
    expect(screen.getByText("Backend + Frontend run")).toBeVisible();
  });

  it("says Dispatch is live, connecting or reconnecting", () => {
    const { rerender } = render(<RunView live={live()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Dispatch live · connected");
    rerender(<RunView live={live({ connection: "reconnecting" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
    rerender(<RunView live={live({ connection: "connecting" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
  });

  it("holds a place until the run arrives", () => {
    render(<RunView live={live({ run: null, log: [] })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading run…");
  });

  it("shows another step when it is clicked, and stays on it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<RunView live={live()} />);
    await user.click(screen.getByRole("button", { name: /Trail map/ }));
    expect(screen.getByRole("heading", { name: /Trail map/ })).toHaveTextContent("Triage");
    expect(screen.getByText(/Done · took/)).toHaveTextContent("Done · took 41s");
    expect(screen.getByText(/none are frontend/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Trail map/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    rerender(<RunView live={live({ run: huddleBegun() })} />);
    expect(screen.getByRole("heading", { name: /Trail map/ })).toBeVisible();
  });

  it("follows the run to its next step until a step has been clicked", () => {
    const { rerender } = render(<RunView live={live()} />);
    expect(screen.getByRole("heading", { name: /Patrol sweep/ })).toBeVisible();
    rerender(<RunView live={live({ run: huddleBegun() })} />);
    expect(screen.getByRole("heading", { name: /Patrol huddle/ })).toBeVisible();
  });

  it("counts the finished steps", () => {
    render(<RunView live={live()} />);
    expect(screen.getByText("2 of 7 done · flags mark milestones")).toBeVisible();
  });

  it("explains a step that has nothing to report", async () => {
    const user = userEvent.setup();
    render(<RunView live={live()} />);
    await user.click(screen.getByRole("button", { name: /Drop in/ }));
    expect(screen.getByText("Not started yet")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Conditions report · step notes" })).toBeVisible();
    expect(screen.getByText("Nothing to report yet.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Patrol on this step · reviewers" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Debug" })).toBeNull();
  });

  describe("time on step", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("counts up each second while the step is active", () => {
      vi.setSystemTime(START + 872_000);
      render(<RunView live={live()} />);
      expect(screen.getByText("14m 32s", { selector: "strong" })).toBeVisible();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText("14m 33s", { selector: "strong" })).toBeVisible();
    });
  });

  it("pairs each themed heading with its plain meaning", () => {
    render(<RunView live={live()} />);
    expect(screen.getByRole("heading", { name: "Conditions report · step notes" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Patrol on this step · reviewers" })).toBeVisible();
    expect(screen.getByRole("heading", { name: /^Radio log · logs/ })).toBeVisible();
  });

  describe("patrol cards", () => {
    it("show name, role, status and summary, with every status in words", () => {
      const statuses = [
        ["queued", "Queued"],
        ["dispatched", "Dispatched"],
        ["running", "Running"],
        ["stalled", "Stalled"],
        ["clear", "Clear"],
        ["hazards", "Hazards flagged"],
        ["error", "Failed"],
        ["stopped", "Stopped"],
      ] as const;
      const agents = statuses.map(([status], index) =>
        agent("mainline", { id: `mainline-sweep-${index}`, status, summary: `summary ${status}` }),
      );
      render(<RunView live={live({ run: withAgents(...agents) })} />);
      for (const [status, label] of statuses) {
        const card = screen.getByRole("button", { name: new RegExp(`summary ${status}$`) });
        expect(card).toHaveTextContent("Mainline");
        expect(card).toHaveTextContent("Functionality");
        expect(card).toHaveTextContent(label);
      }
    });

    it("shows a stopped agent as Stopped", () => {
      const stopped = agent("mainline", { status: "stopped", summary: "stopped · PR closed" });
      render(<RunView live={live({ run: withAgents(stopped) })} />);
      expect(screen.getByRole("button", { name: /Mainline/ })).toHaveTextContent("Stopped");
    });

    it("lists only the agents of the step on show", async () => {
      const user = userEvent.setup();
      const later = agent("mainline", { id: "mainline-huddle-1", step: "huddle", round: 1 });
      render(<RunView live={live({ run: makeRun({ agents: [...run.agents, later] }) })} />);
      expect(
        screen.getAllByRole("button", { name: /Functionality|Goal fit|Security/ }),
      ).toHaveLength(3);
      await user.click(screen.getByRole("button", { name: /Patrol huddle/ }));
      expect(
        screen.getAllByRole("button", { name: /Functionality|Goal fit|Security/ }),
      ).toHaveLength(1);
    });

    it("falls back to the role id for a role no longer in the roster", () => {
      const roster = config.roster;
      config.roster = roster.filter((entry) => entry.id !== "bluebird");
      try {
        const orphan = agent("bluebird", { summary: "left over from an older roster" });
        render(<RunView live={live({ run: withAgents(orphan) })} />);
        expect(screen.getByRole("button", { name: /bluebird.*left over/ })).toBeVisible();
      } finally {
        config.roster = roster;
      }
    });
  });

  describe("radio log for a step", () => {
    it("holds the lines of that step's patrol and of dispatch during the step", async () => {
      const user = userEvent.setup();
      const huddle = agent("mainline", { id: "mainline-huddle-1", step: "huddle", round: 1 });
      const begun = huddleBegun();
      const stepped = { ...begun, agents: [...begun.agents, huddle] };
      const lines = [
        line(1, null, { ts: START + 1000, text: "sweep started" }),
        line(2, "mainline-sweep-0", { ts: START + 2000, text: "sweep request" }),
        line(3, null, { ts: START + 9500, text: "huddle started" }),
        line(4, "mainline-huddle-1", { ts: START + 9600, text: "huddle request" }),
      ];
      render(<RunView live={live({ run: stepped, log: lines })} />);
      const shown = () =>
        within(screen.getByRole("region", { name: "Radio log · logs" }))
          .queryAllByRole("listitem")
          .map((item) => item.textContent ?? "");

      expect(shown()).toEqual([
        expect.stringContaining("huddle started"),
        expect.stringContaining("huddle request"),
      ]);
      await user.click(screen.getByRole("button", { name: /Patrol sweep/ }));
      expect(shown()).toEqual([
        expect.stringContaining("sweep started"),
        expect.stringContaining("sweep request"),
      ]);
    });

    it("is quiet for a step that has not started", async () => {
      const user = userEvent.setup();
      render(<RunView live={live()} />);
      await user.click(screen.getByRole("button", { name: /Drop in/ }));
      expect(screen.getByText("Quiet on the radio.")).toBeVisible();
    });

    it("never hides a line from every step", async () => {
      const user = userEvent.setup();
      const early = line(9, null, { ts: START - 999_999, text: "very early" });
      render(<RunView live={live({ log: [early] })} />);
      await user.click(screen.getByRole("button", { name: /Lift line/ }));
      expect(screen.getByText("very early")).toBeVisible();
    });

    it("labels the log by its scope", async () => {
      const user = userEvent.setup();
      render(<RunView live={live()} />);
      expect(screen.getByRole("heading", { name: /Radio log/ })).toHaveTextContent(
        "Radio log · logs · all patrol",
      );
      await user.click(screen.getByRole("button", { name: /Trail map/ }));
      expect(screen.getByRole("heading", { name: /Radio log/ })).toHaveTextContent(
        "Radio log · logs · dispatch",
      );
    });
  });

  describe("debug", () => {
    it("targets the picked agent, else the first of the step, and says which", async () => {
      const user = userEvent.setup();
      const kt = agent("kt-22", {
        jobUrl: "https://github.com/aghchan/simplegoapp/actions/runs/9/job/7",
      });
      render(<RunView live={live({ run: withAgents(run.agents[0]!, kt) })} />);
      const debug = () => screen.getByRole("heading", { name: "Debug" }).parentElement!;
      expect(within(debug()).getByText("Mainline")).toBeVisible();
      expect(screen.getByRole("link", { name: "GitHub Actions job" })).toHaveAttribute(
        "href",
        JOB_URL,
      );

      await user.click(screen.getByRole("button", { name: /KT-22/ }));
      expect(within(debug()).getByText("KT-22")).toBeVisible();
      expect(screen.getByRole("link", { name: "GitHub Actions job" })).toHaveAttribute(
        "href",
        kt.jobUrl,
      );
    });

    it.each([
      ["a javascript: url", "javascript:alert(1)"],
      ["another site", "https://example.com/aghchan/simplegoapp"],
      ["a look-alike host", "https://github.com.evil.example/x"],
      ["plain http", "http://github.com/aghchan/simplegoapp"],
      ["a data: url", "data:text/html,<script>alert(1)</script>"],
    ])("does not link the Actions job when the url is %s", (_name, jobUrl) => {
      render(<RunView live={live({ run: withAgents(agent("mainline", { jobUrl })) })} />);
      expect(screen.queryByRole("link", { name: "GitHub Actions job" })).toBeNull();
    });

    it("does not link the Actions job when there is none yet", () => {
      render(<RunView live={live({ run: withAgents(agent("mainline", { status: "queued" })) })} />);
      expect(screen.queryByRole("link", { name: "GitHub Actions job" })).toBeNull();
    });

    it("does not link a pull request that is not on GitHub", () => {
      render(<RunView live={live({ run: makeRun({ prUrl: "https://example.com/pull/58" }) })} />);
      expect(screen.queryByRole("link", { name: "View PR on GitHub" })).toBeNull();
    });
  });

  describe("full transcript", () => {
    const TRANSCRIPT_PATH = "/api/runs/r1/agents/mainline-sweep-0/transcript";
    const longText = "x".repeat(3000);
    const ndjson = [
      JSON.stringify({ type: "system", subtype: "init", model: "test-model" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: longText }] },
      }),
      "",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "go test ./..." } }],
        },
      }),
      "not json",
      JSON.stringify({ type: "result", subtype: "success", num_turns: 4, duration_ms: 12000 }),
    ].join("\n");

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("is off until the transcript has been uploaded", () => {
      const waiting = agent("mainline", { hasTranscript: false, jobUrl: JOB_URL });
      render(<RunView live={live({ run: withAgents(waiting) })} />);
      expect(screen.getByRole("button", { name: "Full transcript" })).toBeDisabled();
      expect(screen.getByText("No transcript uploaded yet.")).toBeVisible();
    });

    it("fetches the transcript and shows every line in full", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn(async () => new Response(ndjson));
      vi.stubGlobal("fetch", fetchMock);
      render(<RunView live={live()} />);
      const button = screen.getByRole("button", { name: "Full transcript" });
      expect(button).toBeEnabled();
      expect(button).toHaveAttribute("aria-expanded", "false");

      await user.click(button);
      expect(await screen.findByText(longText)).toBeVisible();
      expect(fetchMock).toHaveBeenCalledWith(TRANSCRIPT_PATH);
      expect(screen.getByText("session started · model test-model")).toBeVisible();
      expect(screen.getByText("Bash go test ./...")).toBeVisible();
      expect(screen.getByText("success · 4 turns · 12s")).toBeVisible();
      expect(button).toHaveAttribute("aria-expanded", "true");
    });

    it("closes again from the same button", async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(ndjson)),
      );
      render(<RunView live={live()} />);
      await user.click(screen.getByRole("button", { name: "Full transcript" }));
      await screen.findByText("success · 4 turns · 12s");
      await user.click(screen.getByRole("button", { name: "Full transcript" }));
      expect(screen.queryByText("success · 4 turns · 12s")).toBeNull();
    });

    it("closes when another patroller is picked, and stays closed on the way back", async () => {
      const user = userEvent.setup();
      const kt = agent("kt-22", { hasTranscript: true, status: "clear" });
      const fetchMock = vi.fn(async () => new Response(ndjson));
      vi.stubGlobal("fetch", fetchMock);
      render(<RunView live={live({ run: withAgents(run.agents[0]!, kt) })} />);
      const button = () => screen.getByRole("button", { name: "Full transcript" });

      await user.click(button());
      await screen.findByText("success · 4 turns · 12s");
      expect(button()).toHaveAttribute("aria-expanded", "true");

      await user.click(screen.getByRole("button", { name: /KT-22/ }));
      expect(button()).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("success · 4 turns · 12s")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await user.click(button());
      await screen.findByText("success · 4 turns · 12s");
      await user.click(screen.getByRole("button", { name: /KT-22/ }));
      expect(button()).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("success · 4 turns · 12s")).toBeNull();
    });

    it("is memoized, so the clock tick does not render it again", () => {
      expect((Transcript as unknown as { $$typeof: symbol }).$$typeof).toBe(
        Symbol.for("react.memo"),
      );
    });

    it("renders transcript text as text, never as markup", async () => {
      const user = userEvent.setup();
      const text = '<img src="x" onerror="alert(1)">';
      const body = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body)),
      );
      const { container } = render(<RunView live={live()} />);
      await user.click(screen.getByRole("button", { name: "Full transcript" }));
      expect(await screen.findByText(text)).toBeVisible();
      expect(container.querySelector("img")).toBeNull();
    });

    describe("when it is not there yet", () => {
      const NOT_YET = "Transcript not available yet — it can take a minute to appear.";

      it("says it can take a minute, and fetches again on Try again", async () => {
        const user = userEvent.setup();
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(new Response(null, { status: 404 }))
          .mockResolvedValueOnce(new Response(ndjson));
        vi.stubGlobal("fetch", fetchMock);
        render(<RunView live={live()} />);
        await user.click(screen.getByRole("button", { name: "Full transcript" }));
        expect(await screen.findByText(NOT_YET)).toBeVisible();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("success · 4 turns · 12s")).toBeVisible();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenLastCalledWith(TRANSCRIPT_PATH);
        expect(screen.queryByText(NOT_YET)).toBeNull();
        expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      });

      it("offers Try again again when the retry finds nothing either", async () => {
        const user = userEvent.setup();
        const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
        vi.stubGlobal("fetch", fetchMock);
        render(<RunView live={live()} />);
        await user.click(screen.getByRole("button", { name: "Full transcript" }));
        await user.click(await screen.findByRole("button", { name: "Try again" }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(await screen.findByText(NOT_YET)).toBeVisible();
        expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
      });

      it("lets a failed retry report the failure", async () => {
        const user = userEvent.setup();
        vi.stubGlobal(
          "fetch",
          vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 404 }))
            .mockResolvedValueOnce(new Response(null, { status: 500 })),
        );
        render(<RunView live={live()} />);
        await user.click(screen.getByRole("button", { name: "Full transcript" }));
        await user.click(await screen.findByRole("button", { name: "Try again" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the transcript");
      });
    });

    it("says so when the transcript cannot be loaded", async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 500 })),
      );
      render(<RunView live={live()} />);
      await user.click(screen.getByRole("button", { name: "Full transcript" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the transcript");
    });

    it("sends a signed-out viewer to sign in", async () => {
      const user = userEvent.setup();
      vi.spyOn(api, "navigateTo").mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 401 })),
      );
      render(<RunView live={live()} />);
      await user.click(screen.getByRole("button", { name: "Full transcript" }));
      await waitFor(() => expect(api.navigateTo).toHaveBeenCalledWith("/auth/login"));
      vi.restoreAllMocks();
    });
  });
});

describe("RunPage", () => {
  const WebSocketStub = FakeWebSocket as unknown as typeof WebSocket;

  function stubRun(answer: () => Response) {
    const fetchMock = vi.fn(async (path: string) =>
      path === "/api/runs/r1" ? answer() : new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", WebSocketStub);
    vi.spyOn(api, "navigateTo").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("paints the fetched run first, then goes live", async () => {
    stubRun(() => Response.json({ run, log }));
    render(<RunPage runId="r1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading run…");
    expect(FakeWebSocket.instances).toHaveLength(0);

    expect(await screen.findByRole("heading", { name: /Patrol sweep/ })).toBeVisible();
    expect(screen.getByText("app healthy on :8080")).toBeVisible();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.last.url).toBe(`ws://${window.location.host}/api/runs/r1/live`);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");

    act(() => FakeWebSocket.last.open());
    expect(screen.getByRole("status")).toHaveTextContent("Dispatch live · connected");
  });

  it("adds the lines that arrive over the socket, in order, once each", async () => {
    stubRun(() => Response.json({ run, log }));
    render(<RunPage runId="r1" />);
    await screen.findByRole("heading", { name: /Patrol sweep/ });
    act(() => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.send({ type: "snapshot", run, log }));
    act(() =>
      FakeWebSocket.last.send({
        type: "log",
        lines: [line(5, null, { text: "fifth" }), line(4, null, { text: "fourth" }), log[2]!],
      }),
    );
    const texts = within(screen.getByRole("region", { name: "Radio log · logs" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(texts).toHaveLength(5);
    expect(texts[3]).toContain("fourth");
    expect(texts[4]).toContain("fifth");
  });

  it("shows run changes sent over the socket", async () => {
    stubRun(() => Response.json({ run, log }));
    render(<RunPage runId="r1" />);
    await screen.findByRole("heading", { name: /Patrol sweep/ });
    act(() => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.send({ type: "run", run: huddleBegun() }));
    expect(screen.getByRole("heading", { name: /Patrol huddle/ })).toBeVisible();
  });

  it("sends a signed-out viewer to sign in and opens no socket", async () => {
    stubRun(() => Response.json({ error: "signed out" }, { status: 401 }));
    render(<RunPage runId="r1" />);
    await waitFor(() => expect(api.navigateTo).toHaveBeenCalledWith("/auth/login"));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("says when the run does not exist", async () => {
    stubRun(() => new Response(null, { status: 404 }));
    render(<RunPage runId="r1" />);
    expect(await screen.findByRole("heading", { name: "Run not found" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to the runs" })).toHaveAttribute("href", "/");
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(api.navigateTo).not.toHaveBeenCalled();
  });

  it("reports a failed load without signing out", async () => {
    stubRun(() => new Response(null, { status: 500 }));
    render(<RunPage runId="r1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this run");
    expect(api.navigateTo).not.toHaveBeenCalled();
  });

  it("stops listening when the page is left", async () => {
    stubRun(() => Response.json({ run, log }));
    const { unmount } = render(<RunPage runId="r1" />);
    await screen.findByRole("heading", { name: /Patrol sweep/ });
    unmount();
    expect(FakeWebSocket.last.closed).toBe(true);
  });

  it("does not open a socket if the page is left before the run loads", async () => {
    let finish: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const { unmount } = render(<RunPage runId="r1" />);
    unmount();
    await act(async () => finish(Response.json({ run, log })));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
