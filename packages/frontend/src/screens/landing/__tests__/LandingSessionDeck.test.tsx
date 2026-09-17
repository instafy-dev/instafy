// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingSessionDeck, MANUAL_HOLD_MS, ROTATE_INTERVAL_MS, SESSION_SCENARIOS } from "../LandingSessionDeck";

describe("landing workspace example", () => {
  let container: HTMLDivElement;
  let root: Root;
  let intersect: IntersectionObserverCallback;
  let observer: IntersectionObserver;
  const disconnect = vi.fn();
  const scenarioChanged = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    disconnect.mockReset();
    scenarioChanged.mockReset();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
        observer = this as unknown as IntersectionObserver;
      }
      observe = vi.fn();
      disconnect = disconnect;
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function mount() {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <LandingSessionDeck
            joinToFor={(scenario) => `/login?example=${scenario.id}`}
            onScenarioChange={scenarioChanged}
          />
        </MemoryRouter>,
      );
    });
  }

  async function setVisible(visible: boolean) {
    await act(async () => {
      intersect([{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], observer);
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }

  function button(label: string): HTMLButtonElement {
    const target = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === label);
    expect(target).toBeDefined();
    expect(target?.hasAttribute("aria-label")).toBe(false);
    return target!;
  }

  function activeMarks() {
    return container.querySelectorAll('[data-octo-motion="thinking"][data-octo-animated="true"]');
  }

  function deck(): HTMLElement {
    return container.querySelector('[data-testid="landing-session-deck"]') as HTMLElement;
  }

  function activeExample(): string | null {
    return deck().getAttribute("data-example");
  }

  // Text the visitor can actually see: inactive scenario copy stays in the
  // tree (so the deck keeps one height) but is hidden from sight and readers.
  function shownText(): string {
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
    return clone.textContent ?? "";
  }

  it("shows one manually selected example with native keyboard-focusable controls", async () => {
    vi.useFakeTimers();
    await mount();
    const books = button("Close the books");
    expect(books.type).toBe("button");
    books.focus();
    expect(document.activeElement).toBe(books);
    await act(async () => books.click());

    expect(books.getAttribute("aria-pressed")).toBe("true");
    expect(button("Build a feature").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelectorAll('[aria-label$=" conversation"]')).toHaveLength(1);
    expect(shownText()).toContain(SESSION_SCENARIOS[1].prompt);
    expect(shownText()).not.toContain(SESSION_SCENARIOS[0].prompt);
    // The scenario's own agent, named on the purple hero cursor, is listed in
    // the space so the name has a referent on the page.
    expect(shownText()).toContain(SESSION_SCENARIOS[1].presenceAgent);
    expect(shownText()).not.toContain(SESSION_SCENARIOS[0].presenceAgent);
    expect(container.querySelector('[data-testid="landing-join-session-button"]')?.getAttribute("href")).toBe("/login?example=books");
    expect(scenarioChanged).toHaveBeenLastCalledWith(SESSION_SCENARIOS[1]);

    await advance(20_000);
    expect(activeExample()).toBe("books");
    await act(async () => button("Launch a site").click());
    expect(shownText()).toContain("Room for your next idea.");
    expect(shownText()).not.toContain("February reconciliation");
  });

  it("keeps every scenario's copy laid out so switching does not change the deck's height", async () => {
    await mount();
    const copies = container.querySelectorAll("[data-scenario-copy]");
    expect(copies.length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-scenario-copy="active"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-scenario-copy="inactive"][aria-hidden="true"]')).toHaveLength(6);
    expect(Array.from(container.querySelectorAll('[data-scenario-copy="inactive"]')).every((node) => node.classList.contains("invisible"))).toBe(true);
    expect(Array.from(container.querySelectorAll('[data-scenario-copy="active"]')).every((node) => !node.classList.contains("invisible"))).toBe(true);
    expect(container.textContent).toContain(SESSION_SCENARIOS[2].prompt);
    expect(shownText()).not.toContain(SESSION_SCENARIOS[2].prompt);
  });

  it("advances every eight seconds while visible and never moves focus", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    expect(activeExample()).toBe("code");
    expect(deck().parentElement?.getAttribute("data-rotating")).toBe("true");

    await advance(ROTATE_INTERVAL_MS - 1);
    expect(activeExample()).toBe("code");
    await advance(1);
    expect(activeExample()).toBe("books");
    expect(scenarioChanged).toHaveBeenLastCalledWith(SESSION_SCENARIOS[1]);
    expect(button("Close the books").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(document.body);

    await advance(ROTATE_INTERVAL_MS);
    expect(activeExample()).toBe("site");
    await advance(ROTATE_INTERVAL_MS);
    expect(activeExample()).toBe("code");
    expect(container.querySelector('[data-testid="landing-join-session-button"]')?.getAttribute("href")).toBe("/login?example=code");
  });

  it("waits while the pointer is over the deck or focus is inside it, then restarts a full countdown", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    const rootNode = container.querySelector('[data-testid="landing-session-deck-root"]') as HTMLElement;

    await advance(ROTATE_INTERVAL_MS / 2);
    await act(async () => {
      rootNode.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    expect(rootNode.getAttribute("data-rotating")).toBe("false");
    await advance(ROTATE_INTERVAL_MS * 3);
    expect(activeExample()).toBe("code");

    await act(async () => {
      rootNode.dispatchEvent(new Event("pointerout", { bubbles: true }));
    });
    expect(rootNode.getAttribute("data-rotating")).toBe("true");
    await advance(ROTATE_INTERVAL_MS - 1);
    expect(activeExample()).toBe("code");
    await advance(1);
    expect(activeExample()).toBe("books");

    const join = container.querySelector('[data-testid="landing-join-session-button"]') as HTMLAnchorElement;
    await act(async () => join.focus());
    expect(document.activeElement).toBe(join);
    expect(rootNode.getAttribute("data-rotating")).toBe("false");
    await advance(ROTATE_INTERVAL_MS * 3);
    expect(activeExample()).toBe("books");

    await act(async () => join.blur());
    expect(rootNode.getAttribute("data-rotating")).toBe("true");
    await advance(ROTATE_INTERVAL_MS);
    expect(activeExample()).toBe("site");
  });

  it("holds a manual selection for twenty seconds before rotation resumes", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    const rootNode = container.querySelector('[data-testid="landing-session-deck-root"]') as HTMLElement;

    await act(async () => button("Launch a site").click());
    expect(activeExample()).toBe("site");
    expect(rootNode.getAttribute("data-rotating")).toBe("false");
    await advance(MANUAL_HOLD_MS - 1);
    expect(activeExample()).toBe("site");

    // A second choice restarts the hold.
    await act(async () => button("Build a feature").click());
    await advance(MANUAL_HOLD_MS - 1);
    expect(activeExample()).toBe("code");
    await advance(1);
    expect(rootNode.getAttribute("data-rotating")).toBe("true");
    expect(activeExample()).toBe("code");
    await advance(ROTATE_INTERVAL_MS);
    expect(activeExample()).toBe("books");
  });

  it("resumes after a mouse click leaves focus on the chosen chip once the pointer moves away", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    const rootNode = container.querySelector('[data-testid="landing-session-deck-root"]') as HTMLElement;
    const chip = button("Launch a site");

    // Browsers (other than Safari) focus a button on click: pointerdown,
    // focus, click, then the pointer leaves the deck.
    await act(async () => {
      rootNode.dispatchEvent(new Event("pointerover", { bubbles: true }));
      chip.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      chip.focus();
      chip.click();
    });
    expect(document.activeElement).toBe(chip);
    expect(activeExample()).toBe("site");
    await act(async () => {
      rootNode.dispatchEvent(new Event("pointerout", { bubbles: true }));
    });

    expect(rootNode.getAttribute("data-rotating")).toBe("false");
    await advance(MANUAL_HOLD_MS - 1);
    expect(rootNode.getAttribute("data-rotating")).toBe("false");
    expect(activeExample()).toBe("site");
    await advance(1);
    expect(rootNode.getAttribute("data-rotating")).toBe("true");
    expect(document.activeElement).toBe(chip);
    await advance(ROTATE_INTERVAL_MS);
    expect(activeExample()).toBe("code");

    // The same for the play control: pressing Play with the mouse must not
    // leave rotation stopped while the label says motion is playing.
    await act(async () => {
      rootNode.dispatchEvent(new Event("pointerover", { bubbles: true }));
      const pause = button("Pause motion");
      pause.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      pause.focus();
      pause.click();
    });
    await act(async () => {
      const play = button("Play motion");
      play.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      play.focus();
      play.click();
      rootNode.dispatchEvent(new Event("pointerout", { bubbles: true }));
    });
    expect(button("Pause motion")).toBe(document.activeElement);
    expect(rootNode.getAttribute("data-rotating")).toBe("true");
    await advance(ROTATE_INTERVAL_MS);
    expect(activeExample()).toBe("books");
  });

  it("holds while keyboard focus is inside the deck", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    const rootNode = container.querySelector('[data-testid="landing-session-deck-root"]') as HTMLElement;
    const chip = button("Close the books");

    // A Tab press happens on whatever was focused before, outside the deck.
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      chip.focus();
    });
    expect(document.activeElement).toBe(chip);
    expect(rootNode.getAttribute("data-rotating")).toBe("false");
    await advance(ROTATE_INTERVAL_MS * 3);
    expect(activeExample()).toBe("code");
    expect(document.activeElement).toBe(chip);

    await act(async () => chip.blur());
    expect(rootNode.getAttribute("data-rotating")).toBe("true");
  });

  it("stops rotating while motion is paused and resumes on play", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    await act(async () => button("Pause motion").click());
    expect(button("Play motion").textContent?.trim()).toBe("Play motion");
    await advance(ROTATE_INTERVAL_MS * 3);
    expect(activeExample()).toBe("code");

    await act(async () => button("Play motion").click());
    await advance(ROTATE_INTERVAL_MS);
    expect(activeExample()).toBe("books");
  });

  it("does not rotate offscreen or in a hidden tab", async () => {
    vi.useFakeTimers();
    await mount();
    await advance(ROTATE_INTERVAL_MS * 2);
    expect(activeExample()).toBe("code");

    await setVisible(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(ROTATE_INTERVAL_MS * 2);
    expect(activeExample()).toBe("code");

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(ROTATE_INTERVAL_MS);
    expect(activeExample()).toBe("books");
  });

  it("animates only the visible working Octo and preserves an explicit pause across selections", async () => {
    await mount();
    expect(activeMarks()).toHaveLength(0);
    await setVisible(true);
    expect(activeMarks()).toHaveLength(1);
    expect(container.querySelectorAll('animate[data-octo-animation="tentacle"]')).toHaveLength(4);

    await act(async () => button("Pause motion").click());
    expect(activeMarks()).toHaveLength(0);
    expect(container.querySelectorAll("animate, animateTransform")).toHaveLength(0);
    await act(async () => button("Close the books").click());
    expect(activeMarks()).toHaveLength(0);
    await act(async () => button("Play motion").click());
    expect(activeMarks()).toHaveLength(1);
  });

  it("pauses offscreen and in a hidden tab, then resumes only when both are visible", async () => {
    await mount();
    await setVisible(true);
    expect(activeMarks()).toHaveLength(1);
    await setVisible(false);
    expect(activeMarks()).toHaveLength(0);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await setVisible(true);
    expect(activeMarks()).toHaveLength(0);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(activeMarks()).toHaveLength(1);
    await act(async () => root.unmount());
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps reduced-motion examples static while the manual selectors remain available", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    await mount();
    await setVisible(true);
    expect(activeMarks()).toHaveLength(0);
    expect(container.querySelectorAll("animate, animateTransform")).toHaveLength(0);
    expect(container.querySelector('[data-testid="landing-session-deck-root"]')?.getAttribute("data-rotating")).toBe("false");
    await advance(ROTATE_INTERVAL_MS * 3);
    expect(activeExample()).toBe("code");
    await act(async () => button("Launch a site").click());
    expect(shownText()).toContain(SESSION_SCENARIOS[2].prompt);
    expect(activeMarks()).toHaveLength(0);
  });
});
