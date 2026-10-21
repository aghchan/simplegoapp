import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "../../shared/src/types.ts";
import { App } from "../src/App.tsx";
import * as api from "../src/api.ts";

const RUNS: RunSummary[] = [
  {
    id: "r1",
    prNumber: 58,
    prTitle: "orders: add cancel endpoint",
    runName: "Red Dog Face",
    rating: "black",
    status: "on_the_hill",
    currentStep: "sweep",
    updatedAt: 1,
  },
];

function stubApi(answers: Record<string, () => Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => answers[path]?.() ?? new Response(null, { status: 404 })),
  );
}

function signedIn(): void {
  stubApi({
    "/api/me": () => Response.json({ login: "aghchan" }),
    "/api/runs": () => Response.json(RUNS),
  });
}

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.spyOn(api, "navigateTo").mockImplementation(() => {});
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

  it("holds the place of the run page and marks the run as open", async () => {
    window.history.replaceState(null, "", "/runs/r1");
    signedIn();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Loading run…" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Red Dog Face/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens a run without reloading the page", async () => {
    signedIn();
    render(<App />);
    await userEvent.click(await screen.findByRole("link", { name: /Red Dog Face/ }));
    expect(await screen.findByRole("heading", { name: "Loading run…" })).toBeVisible();
    expect(window.location.pathname).toBe("/runs/r1");
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
});
