import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RadioLog } from "../src/components/RadioLog.tsx";
import { line } from "./fixtures.ts";

const names = { "mainline-sweep-0": "Mainline", "kt-22-sweep-0": "KT-22" };
const dispatch = (id: number) => line(id);
const patrol = (id: number, agentId: string) => line(id, agentId);

describe("RadioLog", () => {
  it("filters by agent", () => {
    render(
      <RadioLog
        lines={[dispatch(1), patrol(2, "mainline-sweep-0"), patrol(3, "x")]}
        agentId="mainline-sweep-0"
        names={names}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("line 2")).toBeVisible();
  });

  it("shows every line when no agent is picked, in the order given", () => {
    render(
      <RadioLog
        lines={[dispatch(1), patrol(2, "mainline-sweep-0"), patrol(3, "kt-22-sweep-0")]}
        agentId={null}
        names={names}
      />,
    );
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("line 1"),
      expect.stringContaining("line 2"),
      expect.stringContaining("line 3"),
    ]);
  });

  it("labels dispatch lines, patrollers by name, and unknown agents by id", () => {
    render(
      <RadioLog
        lines={[dispatch(1), patrol(2, "mainline-sweep-0"), patrol(3, "unlisted-sweep-0")]}
        agentId={null}
        names={names}
      />,
    );
    const [first, second, third] = screen.getAllByRole("listitem");
    expect(within(first!).getByText("dispatch")).toBeVisible();
    expect(within(second!).getByText("Mainline")).toBeVisible();
    expect(within(third!).getByText("unlisted-sweep-0")).toBeVisible();
  });

  it("shows the time of each line as a clock", () => {
    render(<RadioLog lines={[dispatch(1)]} agentId={null} names={names} />);
    expect(screen.getByRole("listitem")).toHaveTextContent(/\d\d:\d\d:\d\d/);
  });

  it("says when there is nothing on the radio", () => {
    render(<RadioLog lines={[]} agentId={null} names={names} />);
    expect(screen.getByText("Quiet on the radio.")).toBeVisible();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("says so when the picked agent has said nothing", () => {
    render(<RadioLog lines={[dispatch(1)]} agentId="mainline-sweep-0" names={names} />);
    expect(screen.getByText("Quiet on the radio.")).toBeVisible();
  });

  it("renders log text as text, never as markup", () => {
    const text = '<img src="x" onerror="alert(1)"> <b>bold</b>';
    const { container } = render(
      <RadioLog lines={[line(1, null, { text })]} agentId={null} names={names} />,
    );
    expect(screen.getByText(text)).toBeVisible();
    expect(container.querySelector("img, b")).toBeNull();
  });

  it("announces only lines that are appended", () => {
    const { rerender } = render(
      <RadioLog lines={[dispatch(1), dispatch(2)]} agentId={null} names={names} />,
    );
    const list = screen.getByRole("list");
    expect(list).toHaveAttribute("aria-live", "polite");
    expect(list).toHaveAttribute("aria-relevant", "additions");

    rerender(
      <RadioLog lines={[dispatch(1), dispatch(2), dispatch(3)]} agentId={null} names={names} />,
    );
    expect(screen.getByRole("list")).toBe(list);
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  });

  it("marks an error line for readers who cannot see its colour", () => {
    render(
      <RadioLog
        lines={[line(1, null, { kind: "error", text: "boom" })]}
        agentId={null}
        names={names}
      />,
    );
    expect(screen.getByRole("listitem")).toHaveTextContent("Error: boom");
  });

  describe("following the newest line", () => {
    function box() {
      return screen.getByRole("region", { name: "Radio log" });
    }

    // jsdom has no layout, so the box's geometry is set by hand: 100px tall, 1000px of lines.
    function measure(element: HTMLElement, scrollTop: number) {
      Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(element, "clientHeight", { configurable: true, value: 100 });
      element.scrollTop = scrollTop;
    }

    it("scrolls to the bottom when a line arrives and the reader is at the bottom", () => {
      const { rerender } = render(<RadioLog lines={[dispatch(1)]} agentId={null} names={names} />);
      measure(box(), 900);
      box().dispatchEvent(new Event("scroll"));
      rerender(<RadioLog lines={[dispatch(1), dispatch(2)]} agentId={null} names={names} />);
      expect(box().scrollTop).toBe(1000);
    });

    it("leaves the reader where they are when they have scrolled up", () => {
      const { rerender } = render(<RadioLog lines={[dispatch(1)]} agentId={null} names={names} />);
      measure(box(), 200);
      box().dispatchEvent(new Event("scroll"));
      rerender(<RadioLog lines={[dispatch(1), dispatch(2)]} agentId={null} names={names} />);
      expect(box().scrollTop).toBe(200);
    });
  });
});
