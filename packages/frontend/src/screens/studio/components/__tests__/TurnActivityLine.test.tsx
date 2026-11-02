// @vitest-environment jsdom

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NavArrowDown, NavArrowRight } from "iconoir-react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { LIVE_ANNOUNCEMENT_INTERVAL_MS, TurnActivityLine } from "../TurnActivityLine";

const DONE = "Looked up 14 places, read 6 pages, built the map";
const DETAILS_ID = "turn-details";

/** The line as a turn mounts it, with the Details it opens and closes. */
function Turn({ text, live = false, interactive = true }: { text: string; live?: boolean; interactive?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TurnActivityLine
        text={text}
        live={live}
        animate={live}
        interactive={interactive}
        detailsOpen={open}
        detailsId={DETAILS_ID}
        onToggleDetails={() => setOpen((current) => !current)}
      />
      {open ? <div id={DETAILS_ID} data-testid="details" /> : null}
    </>
  );
}

/** The shape an icon draws, to tell the closed arrow from the open one. */
function iconShape(icon: ReactElement): string | null {
  const holder = document.createElement("div");
  holder.innerHTML = renderToStaticMarkup(icon);
  return holder.querySelector("path")?.getAttribute("d") ?? null;
}

describe("TurnActivityLine", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const line = () => container.querySelector<HTMLElement>('[data-testid="turn-activity-line"]');
  const words = () => line()?.querySelector<HTMLElement>("[data-sweep-text]") ?? null;
  const arrow = () => line()?.querySelector('[data-testid="turn-activity-line-arrow"]') ?? null;

  // "Details ›" after every turn's line made each line longer and read as a
  // second thing to press. The line's own words open Details.
  it("says only what the turn did, and its own words open and close Details", async () => {
    await act(async () => {
      root.render(<Turn text={DONE} />);
    });

    expect(line()?.tagName).toBe("BUTTON");
    expect(line()?.textContent).toBe(DONE);
    expect(line()?.textContent).not.toMatch(/details/i);
    expect(line()?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="details"]')).toBeNull();

    for (const open of [true, false, true]) {
      await act(async () => {
        words()?.click();
      });
      expect(line()?.getAttribute("aria-expanded")).toBe(String(open));
      expect(container.querySelector('[data-testid="details"]') !== null).toBe(open);
      // Opening adds no "Hide details" either: the words stay what they were.
      expect(line()?.textContent).toBe(DONE);
    }
  });

  it("marks only a line that opens: a pointer, an underline on hover and an arrow after its words", async () => {
    await act(async () => {
      root.render(<Turn text={DONE} />);
    });

    expect(line()?.classList.contains("cursor-pointer")).toBe(true);
    expect(words()?.classList.contains("group-hover/turn-activity:underline")).toBe(true);
    // A small arrow after the words, in the line's own colour, hidden from
    // screen readers: › while Details is closed, ⌄ while it is open.
    expect(arrow()).not.toBeNull();
    expect(line()?.lastElementChild).toBe(arrow());
    expect(arrow()?.getAttribute("aria-hidden")).toBe("true");
    expect([...(arrow()?.classList ?? [])].filter((token) => token.startsWith("text-"))).toEqual([]);
    expect(arrow()?.querySelector("path")?.getAttribute("d")).toBe(iconShape(<NavArrowRight />));
    await act(async () => {
      words()?.click();
    });
    expect(arrow()?.querySelector("path")?.getAttribute("d")).toBe(iconShape(<NavArrowDown />));

    // A line that cannot open (nothing to show yet, or a failed turn whose
    // failure block has the one Details) is plain text: no arrow, no pointer.
    await act(async () => {
      root.render(<Turn key="plain" text="Starting…" live interactive={false} />);
    });
    expect(line()?.tagName).toBe("DIV");
    expect(line()?.textContent).toBe("Starting…");
    expect(line()?.querySelector("svg")).toBeNull();
    expect(line()?.classList.contains("cursor-pointer")).toBe(false);
    expect(words()?.className).not.toContain("underline");
    expect(line()?.hasAttribute("aria-expanded")).toBe(false);
  });

  it("tells a screen reader the line and what pressing it does, and announces only the line", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await act(async () => {
      root.render(<Turn text={DONE} />);
    });

    expect(line()?.getAttribute("aria-label")).toBe(`${DONE}, show details`);
    expect(line()?.getAttribute("aria-controls")).toBe(DETAILS_ID);
    await act(async () => {
      words()?.click();
    });
    expect(line()?.getAttribute("aria-label")).toBe(`${DONE}, hide details`);
    expect(container.querySelector(`#${DETAILS_ID}`)).not.toBeNull();

    // While the turn runs, the polite region says the new step and nothing more.
    await act(async () => {
      root.render(<Turn key="running" text="Looking up places…" live />);
    });
    expect(line()?.getAttribute("aria-label")).toBe("Looking up places…, show details");
    await act(async () => {
      root.render(<Turn key="running" text="Reading pages…" live />);
    });
    await act(async () => {
      vi.advanceTimersByTime(LIVE_ANNOUNCEMENT_INTERVAL_MS);
    });
    expect(container.querySelector('[data-testid="turn-activity-announcement"]')?.textContent).toBe("Reading pages…");
  });
});
