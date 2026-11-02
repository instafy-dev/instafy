// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LABEL_HOLD_MS,
  THINKING_LABEL_DELAY_MS,
  useSteadyActivityLabel,
} from "../useSteadyActivityLabel";

describe("useSteadyActivityLabel", () => {
  let root: Root;
  let container: HTMLDivElement;
  let shownLog: Array<{ at: number; text: string }>;
  let start: number;

  function Harness({ text, live }: { text: string; live: boolean }) {
    const shown = useSteadyActivityLabel(text, live);
    useEffect(() => {
      shownLog.push({ at: Date.now() - start, text: shown });
    }, [shown]);
    return <div data-testid="line">{shown}</div>;
  }

  const line = () => container.querySelector('[data-testid="line"]')?.textContent;
  const render = (text: string, live = true) =>
    act(async () => {
      root.render(<Harness text={text} live={live} />);
    });
  // In steps, so each change is logged at the time it happened.
  const STEP_MS = 20;
  const wait = async (ms: number) => {
    for (let left = ms; left > 0; left -= STEP_MS) {
      await act(async () => {
        vi.advanceTimersByTime(Math.min(STEP_MS, left));
      });
    }
  };
  /** Labels as the line showed them, each with how long it stayed. */
  const shownFor = (end: number) =>
    shownLog.map((entry, index) => ({
      text: entry.text,
      ms: (shownLog[index + 1]?.at ?? end) - entry.at,
    }));

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    start = Date.now();
    shownLog = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  // A map turn in a local test, sampled every 200 ms: "Working on the map…" for 239 ms
  // and 131 ms with "Thinking…" between, "Looking up transit…" for 457 ms,
  // "Saving your changes…" for 36 ms.
  it("never flashes a label: each one it shows holds for at least the hold time", async () => {
    const steps: Array<[number, string]> = [
      [0, "Starting…"],
      [200, "Thinking…"],
      [3_400, "Working on the map…"],
      [3_639, "Thinking…"],
      [3_700, "Working on the map…"],
      [3_831, "Thinking…"],
      [5_000, "Looking up transit…"],
      [5_457, "Thinking…"],
      [5_600, "Finding places to stay…"],
      [38_600, "Thinking…"],
      [38_700, "Saving your changes…"],
      [38_736, "Thinking…"],
    ];
    let now = 0;
    for (const [at, text] of steps) {
      await wait(at - now);
      now = at;
      await render(text);
    }
    await wait(10_000);
    const shown = shownFor(now + 10_000);
    for (const entry of shown.slice(0, -1)) {
      expect(entry.ms, entry.text).toBeGreaterThanOrEqual(ACTIVITY_LABEL_HOLD_MS - STEP_MS);
    }
    // The two short "Working on the map…" never had their turn: by the time
    // one could show, the next step was there.
    expect(shown.map((entry) => entry.text)).toEqual([
      "Starting…",
      "Thinking…",
      "Looking up transit…",
      "Finding places to stay…",
      "Saving your changes…",
      "Thinking…",
    ]);
  });

  it("drops a label replaced before its turn came, and keeps the one on screen when it comes back", async () => {
    await render("Working on the map…");
    await wait(300);
    await render("Thinking…");
    await wait(100);
    await render("Working on the map…");
    await wait(5_000);
    expect(shownLog.map((entry) => entry.text)).toEqual(["Working on the map…"]);
    // A label after one that has held shows at once, and then holds itself.
    await render("Saving your changes…");
    expect(line()).toBe("Saving your changes…");
    await wait(36);
    await render("Checking the page…");
    await wait(100);
    await render("Opening the preview…");
    await wait(ACTIVITY_LABEL_HOLD_MS - 137);
    expect(line()).toBe("Saving your changes…");
    await wait(1);
    expect(line()).toBe("Opening the preview…");
    expect(shownLog.map((entry) => entry.text)).toEqual([
      "Working on the map…",
      "Saving your changes…",
      "Opening the preview…",
    ]);
  });

  it("says Thinking only after a pause with no step", async () => {
    await render("Reading pages…");
    await wait(ACTIVITY_LABEL_HOLD_MS);
    await render("Thinking…");
    await wait(THINKING_LABEL_DELAY_MS - 1);
    expect(line()).toBe("Reading pages…");
    await wait(1);
    expect(line()).toBe("Thinking…");
  });

  // A local test: "Saving your changes…" showed for 0.8 s and "Thinking…" for
  // 0.75 s before the turn's done line took their place.
  it("holds the last running label before the done line takes its place", async () => {
    await render("Looking up places…");
    await wait(ACTIVITY_LABEL_HOLD_MS);
    await render("Saving your changes…");
    expect(line()).toBe("Saving your changes…");
    await wait(800);
    await render("Built the map, looked up 4 places", false);
    expect(line()).toBe("Saving your changes…");
    await wait(ACTIVITY_LABEL_HOLD_MS - 800 - STEP_MS);
    expect(line()).toBe("Saving your changes…");
    await wait(STEP_MS);
    expect(line()).toBe("Built the map, looked up 4 places");
    // A label that has held long enough gives way at once.
    await render("Looking up places…");
    await render("Reading pages…");
    await wait(ACTIVITY_LABEL_HOLD_MS);
    expect(line()).toBe("Reading pages…");
    await wait(ACTIVITY_LABEL_HOLD_MS);
    await render("Read 6 pages", false);
    expect(line()).toBe("Read 6 pages");
  });

  it("shows a done line that never ran as it is, and its changes at once", async () => {
    await render("Built the map, planned the days", false);
    expect(line()).toBe("Built the map, planned the days");
    await render("Built the map, looked up 4 places", false);
    expect(line()).toBe("Built the map, looked up 4 places");
  });

  it("shows Waiting for you and a done line at once", async () => {
    await render("Looking up places…");
    await render("Waiting for you");
    expect(line()).toBe("Waiting for you");
    await render("Looked up 3 places", false);
    expect(line()).toBe("Looked up 3 places");
  });

  // Once the person answered, the line never says it still waits for them:
  // "Deny" on a browser prompt read "Waiting for you" for 3 s more.
  it("drops Waiting for you as soon as the person answered", async () => {
    await render("Waiting for you");
    await wait(400);
    await render("Thinking…");
    expect(line()).toBe("Thinking…");
    await render("Waiting for you");
    expect(line()).toBe("Waiting for you");
    await render("Opening visitlisboa.com…");
    expect(line()).toBe("Opening visitlisboa.com…");
  });
});
