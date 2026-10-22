import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "../../shared/src/types.ts";
import { App } from "../src/App.tsx";
import * as api from "../src/api.ts";
import { FakeWebSocket, makeRun } from "./fixtures.ts";

const RUNS: RunSummary[] = [
  {
    id: "r1",
    prNumber: 58,
    prTitle: "orders: add cancel endpoint",
    runName: "Red Dog Face",
    rating: "black",
    status: "on_the_hill",
    outcome: "pending",
    currentStep: "sweep",
    createdAt: 1,
    updatedAt: 1,
  },
];

function stubApi(answers: Record<string, () => Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => answers[path]?.() ?? new Response(null, { status: 404 })),
  );
}

// Started after r1, for another PR.
const NEWER: RunSummary = {
  ...RUNS[0]!,
  id: "r2",
  prNumber: 59,
  runName: "Home Run",
  createdAt: 2,
  updatedAt: 2,
};

const RUN_PAGES: Record<string, () => Response> = {
  "/api/runs/r1": () => Response.json({ run: makeRun(), log: [] }),
  "/api/runs/r2": () =>
    Response.json({ run: makeRun({ id: "r2", prTitle: "orders: list endpoint" }), log: [] }),
};

function signedIn(runs: RunSummary[] = RUNS): void {
  stubApi({
    "/api/me": () => Response.json({ login: "aghchan" }),
    "/api/runs": () => Response.json(runs),
    ...RUN_PAGES,
  });
}

const fetchesOf = (path: string) =>
  vi.mocked(fetch).mock.calls.filter(([called]) => called === path).length;

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.spyOn(api, "navigateTo").mockImplementation(() => {});
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("redirects to sign-in on 401", async () => {
    stubApi({ "/api/me": () => Response.json({ error: "signed out" }, { status: 401 }) });
    render(<App />);
    await waitFor(() => expect(api.navigateTo).toHaveBeenCalledWith("/auth/login"));
  });

  it("lists the runs once signed in", async () => {
    signedIn();
    render(<App />);
    expect(await screen.findByRole("link", { name: /Red Dog Face/ })).toHaveAttribute(
      "href",
      "/runs/r1",
    );
    expect(screen.getByText(/aghchan/)).toBeVisible();
    expect(api.navigateTo).not.toHaveBeenCalled();
  });

  it("reports a failed load without signing out", async () => {
    stubApi({
      "/api/me": () => Response.json({ login: "aghchan" }),
      "/api/runs": () => new Response(null, { status: 500 }),
    });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the dashboard");
    expect(api.navigateTo).not.toHaveBeenCalled();
  });

  it("shows the run page and marks the run as open", async () => {
    window.history.replaceState(null, "", "/runs/r1");
    signedIn();
    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "orders: add cancel endpoint" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /Red Dog Face/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens a run without reloading the page", async () => {
    signedIn([NEWER, ...RUNS]);
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "orders: list endpoint" });
    await userEvent.click(screen.getByRole("link", { name: /Red Dog Face/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "orders: add cancel endpoint" }),
    ).toBeVisible();
    expect(window.location.pathname).toBe("/runs/r1");
  });

  describe("the front page", () => {
    it("shows the newest run, by when it started, and marks it as open", async () => {
      // Listed second: r1 was updated more recently.
      signedIn([{ ...RUNS[0]!, updatedAt: 9 }, NEWER]);
      render(<App />);
      expect(
        await screen.findByRole("heading", { level: 1, name: "orders: list endpoint" }),
      ).toBeVisible();
      expect(screen.getByRole("link", { name: /Home Run/ })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(screen.getByRole("link", { name: /Red Dog Face/ })).not.toHaveAttribute(
        "aria-current",
      );
      expect(window.location.pathname).toBe("/");
      expect(fetchesOf("/api/runs/r1")).toBe(0);
    });

    it("keeps the run on show, without loading it again, when its link pins it", async () => {
      signedIn();
      render(<App />);
      await screen.findByRole("heading", { level: 1, name: "orders: add cancel endpoint" });
      await userEvent.click(screen.getByRole("link", { name: /Red Dog Face/ }));
      expect(window.location.pathname).toBe("/runs/r1");
      expect(
        screen.getByRole("heading", { level: 1, name: "orders: add cancel endpoint" }),
      ).toBeVisible();
      expect(fetchesOf("/api/runs/r1")).toBe(1);
    });

    it("shows no run when there are none", async () => {
      signedIn([]);
      render(<App />);
      expect(await screen.findByText(/No runs yet/)).toBeVisible();
      expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  it("moves to another run with its own data and socket", async () => {
    window.history.replaceState(null, "", "/runs/r1");
    const other = { ...RUNS[0]!, id: "r2", prNumber: 59, runName: "Home Run" };
    stubApi({
      "/api/me": () => Response.json({ login: "aghchan" }),
      "/api/runs": () => Response.json([...RUNS, other]),
      "/api/runs/r1": () => Response.json({ run: makeRun(), log: [] }),
      "/api/runs/r2": () =>
        Response.json({ run: makeRun({ id: "r2", prTitle: "orders: list endpoint" }), log: [] }),
    });
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "orders: add cancel endpoint" });
    const first = await FakeWebSocket.opened(1, /\/api\/runs\/r1\/live$/);

    await userEvent.click(screen.getByRole("link", { name: /Home Run/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "orders: list endpoint" }),
    ).toBeVisible();
    expect(first.closed).toBe(true);
    await FakeWebSocket.opened(1, /\/api\/runs\/r2\/live$/);
  });

  it("leaves a modified click to the browser", async () => {
    signedIn();
    render(<App />);
    const link = await screen.findByRole("link", { name: /Red Dog Face/ });
    // Stops jsdom from attempting the navigation the browser would make.
    document.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(window.location.pathname).toBe("/");
  });

  it("says when a page does not exist", async () => {
    window.history.replaceState(null, "", "/nowhere");
    signedIn();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeVisible();
  });

  describe("keeping the runs list live", () => {
    const POLL_MS = 5000;
    const LOBBY = /\/api\/live$/;
    const OTHER = NEWER;
    let runs: () => Response;
    const runsCalls = () =>
      vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/runs").length;

    // Only the interval is faked: Testing Library's own timeouts and the stubbed fetch stay real.
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const tick = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const showTab = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    };
    // waitFor cannot poll while intervals are faked, so the effect that opens the socket is
    // flushed first.
    const lobby = async () => {
      await settle();
      return FakeWebSocket.opened(1, LOBBY);
    };
    const loaded = async () => {
      render(<App />);
      await screen.findByRole("link", { name: /Red Dog Face/ });
      return lobby();
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      runs = () => Response.json(RUNS);
      stubApi({
        "/api/me": () => Response.json({ login: "aghchan" }),
        "/api/runs": () => runs(),
        ...RUN_PAGES,
      });
    });
    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(document, "visibilityState");
    });

    it("opens the lobby socket once the list has loaded", async () => {
      const socket = await loaded();
      expect(socket.url).toBe(`ws://${window.location.host}/api/live`);
      expect(runsCalls()).toBe(1);
    });

    it("shows a pull request the lobby announces", async () => {
      const socket = await loaded();
      act(() => socket.open());
      await settle();
      act(() => socket.send({ type: "summary", run: { ...OTHER, updatedAt: 2 } }));
      expect(await screen.findByRole("link", { name: /Home Run/ })).toBeVisible();
      expect(screen.getByRole("link", { name: /Red Dog Face/ })).toBeVisible();
    });

    it("moves the front page to a newer run the lobby announces", async () => {
      const socket = await loaded();
      expect(
        await screen.findByRole("heading", { level: 1, name: "orders: add cancel endpoint" }),
      ).toBeVisible();
      act(() => socket.open());
      await settle();
      act(() => socket.send({ type: "summary", run: OTHER }));
      expect(
        await screen.findByRole("heading", { level: 1, name: "orders: list endpoint" }),
      ).toBeVisible();
      expect(screen.getByRole("link", { name: /Home Run/ })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(window.location.pathname).toBe("/");
    });

    it("keeps a pinned run on show when a newer one arrives", async () => {
      window.history.replaceState(null, "", "/runs/r1");
      const socket = await loaded();
      await screen.findByRole("heading", { level: 1, name: "orders: add cancel endpoint" });
      act(() => socket.open());
      await settle();
      act(() => socket.send({ type: "summary", run: OTHER }));
      expect(await screen.findByRole("link", { name: /Home Run/ })).toBeVisible();
      await settle();
      expect(
        screen.getByRole("heading", { level: 1, name: "orders: add cancel endpoint" }),
      ).toBeVisible();
      expect(screen.getByRole("link", { name: /Home Run/ })).not.toHaveAttribute("aria-current");
      expect(fetchesOf("/api/runs/r2")).toBe(0);
    });

    it("moves a run the lobby says was stopped to Closed", async () => {
      const socket = await loaded();
      act(() => socket.open());
      await settle();
      act(() =>
        socket.send({ type: "summary", run: { ...RUNS[0]!, status: "stopped", updatedAt: 2 } }),
      );
      expect(await screen.findByRole("heading", { name: "Closed" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "On the hill · running" })).toBeNull();
    });

    it("refetches when the socket opens, then does not poll while it is up", async () => {
      const socket = await loaded();
      runs = () => Response.json([...RUNS, OTHER]);
      act(() => socket.open());
      expect(await screen.findByRole("link", { name: /Home Run/ })).toBeVisible();
      expect(runsCalls()).toBe(2);
      await tick(POLL_MS * 3);
      expect(runsCalls()).toBe(2);
    });

    // The socket's retry waits on a real timer and then only connects, so it stays down.
    describe("while the lobby socket is down", () => {
      const down = async () => {
        const socket = await loaded();
        act(() => socket.close());
      };

      it("shows a pull request opened after the page loaded", async () => {
        await down();
        runs = () => Response.json([...RUNS, OTHER]);
        await tick(POLL_MS);
        expect(await screen.findByRole("link", { name: /Home Run/ })).toBeVisible();
        expect(screen.getByRole("link", { name: /Red Dog Face/ })).toBeVisible();
      });

      it("reflects a run that changed status", async () => {
        await down();
        expect(screen.getByRole("heading", { name: "On the hill · running" })).toBeVisible();
        runs = () => Response.json([{ ...RUNS[0]!, status: "swept" }]);
        await tick(POLL_MS);
        expect(await screen.findByRole("heading", { name: "Swept · patrol done" })).toBeVisible();
        expect(screen.queryByRole("heading", { name: "On the hill · running" })).toBeNull();
      });

      it("polls every five seconds", async () => {
        await down();
        expect(runsCalls()).toBe(1);
        await tick(POLL_MS - 1);
        expect(runsCalls()).toBe(1);
        await tick(1);
        expect(runsCalls()).toBe(2);
        await tick(POLL_MS * 2);
        expect(runsCalls()).toBe(4);
      });

      it("does not fetch while the tab is hidden", async () => {
        await down();
        showTab("hidden");
        await tick(POLL_MS * 6);
        expect(runsCalls()).toBe(1);
      });

      it("fetches at once when the tab becomes visible, then resumes the cadence", async () => {
        await down();
        showTab("hidden");
        await tick(POLL_MS * 3);
        runs = () => Response.json([...RUNS, OTHER]);

        showTab("visible");
        await settle();
        expect(runsCalls()).toBe(2);
        expect(await screen.findByRole("link", { name: /Home Run/ })).toBeVisible();

        await tick(POLL_MS);
        expect(runsCalls()).toBe(3);
      });

      it("does not poll when the page opens in a hidden tab, until it is shown", async () => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        await down();
        await tick(POLL_MS * 3);
        expect(runsCalls()).toBe(1);
        showTab("visible");
        await settle();
        expect(runsCalls()).toBe(2);
      });

      it("keeps the last list when a refresh fails", async () => {
        await down();
        runs = () => new Response(null, { status: 500 });
        await tick(POLL_MS);
        expect(runsCalls()).toBe(2);
        expect(screen.getByRole("link", { name: /Red Dog Face/ })).toBeVisible();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(api.navigateTo).not.toHaveBeenCalled();

        runs = () => Response.json([...RUNS, OTHER]);
        await tick(POLL_MS);
        expect(await screen.findByRole("link", { name: /Home Run/ })).toBeVisible();
      });

      it("keeps the last list when the network drops", async () => {
        await down();
        runs = () => {
          throw new TypeError("network down");
        };
        await tick(POLL_MS);
        expect(runsCalls()).toBe(2);
        expect(screen.getByRole("link", { name: /Red Dog Face/ })).toBeVisible();
        expect(api.navigateTo).not.toHaveBeenCalled();
      });

      it("sends a viewer whose session ended to sign in", async () => {
        await down();
        runs = () => Response.json({ error: "signed out" }, { status: 401 });
        await tick(POLL_MS);
        await waitFor(() => expect(api.navigateTo).toHaveBeenCalledWith("/auth/login"));
      });
    });

    it("stops polling and listening when the page is closed", async () => {
      const { unmount } = render(<App />);
      await screen.findByRole("link", { name: /Red Dog Face/ });
      const socket = await lobby();
      act(() => socket.close());
      unmount();
      expect(FakeWebSocket.instances.every((each) => each.closed)).toBe(true);
      await tick(POLL_MS * 3);
      showTab("visible");
      await settle();
      expect(runsCalls()).toBe(1);
    });
  });
});
