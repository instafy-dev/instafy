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
    await act(async () => books.focus());
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
    expect(shownText()).toContain("The pricing page is up at forma.site/pricing");
    expect(shownText()).not.toContain("214 of 217 rows matched");
    // The docked browser stands in for a screencast, so the page it draws is
    // decorative: none of its copy is exposed as conversation content.
    expect(shownText()).not.toContain("Room for your next idea.");
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

  it("advances on the rotation interval while visible and never moves focus", async () => {
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

    // The same for the join link, which has no manual hold behind it: pointer
    // focus must not leave rotation stopped once the pointer moves away.
    const join = container.querySelector('[data-testid="landing-join-session-button"]') as HTMLAnchorElement;
    await act(async () => {
      rootNode.dispatchEvent(new Event("pointerover", { bubbles: true }));
      join.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      join.focus();
    });
    expect(rootNode.getAttribute("data-rotating")).toBe("false");
    await act(async () => {
      rootNode.dispatchEvent(new Event("pointerout", { bubbles: true }));
    });
    expect(document.activeElement).toBe(join);
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

  it("animates only the visible working Octo and stays static across selections while suspended", async () => {
    vi.useFakeTimers();
    await mount();
    expect(activeMarks()).toHaveLength(0);
    await setVisible(true);
    // Octo is honestly idle while Ada types; the mark thinks once the run starts.
    await advance(2200);
    expect(activeMarks()).toHaveLength(1);
    expect(container.querySelectorAll('animate[data-octo-animation="tentacle"]')).toHaveLength(4);

    // Suspension outlives a scenario change: picking one offscreen must not
    // start its turn animating where nobody can see it.
    await setVisible(false);
    expect(activeMarks()).toHaveLength(0);
    expect(container.querySelectorAll("animate, animateTransform")).toHaveLength(0);
    await act(async () => button("Close the books").click());
    expect(activeMarks()).toHaveLength(0);
    expect(container.querySelectorAll("animate, animateTransform")).toHaveLength(0);
    await setVisible(true);
    await advance(2200);
    expect(activeMarks()).toHaveLength(1);
  });

  it("pauses offscreen and in a hidden tab, then resumes only when both are visible", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    await advance(2200);
    expect(activeMarks()).toHaveLength(1);
    await setVisible(false);
    expect(activeMarks()).toHaveLength(0);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await setVisible(true);
    expect(activeMarks()).toHaveLength(0);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(2200);
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

  function activeCell(): HTMLElement {
    return container.querySelector('[data-scenario-copy="active"] [data-testid="landing-own-message"]')?.closest('[data-scenario-copy="active"]') as HTMLElement;
  }

  function typedPrompt(): string {
    return container.querySelector('[data-testid="landing-typed-prompt"]')?.textContent ?? "";
  }

  function expectFinishedFrame() {
    expect(deck().dataset.beat).toBe("reply");
    expect(deck().dataset.playing).toBe("false");
    expect(deck().querySelectorAll(".instafy-status-sweep")).toHaveLength(0);
    expect(deck().querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect(deck().querySelectorAll(".animate-spin")).toHaveLength(0);
    expect(deck().querySelectorAll(".instafy-compact-event-pill")).toHaveLength(0);
    expect(deck().querySelectorAll(".instafy-compact-event-pill-live")).toHaveLength(0);
    expect(deck().querySelectorAll("animate, animateTransform")).toHaveLength(0);
    expect(deck().querySelector('[data-testid="landing-kim-typing"]')).toBeNull();
    expect(typedPrompt()).toBe("");
    expect(deck().querySelector('[data-testid="landing-composer-mic"]')).not.toBeNull();
    const cell = activeCell();
    const reveals = Array.from(cell.querySelectorAll("[data-beat-visible]"));
    expect(reveals.length).toBeGreaterThan(0);
    expect(reveals.every((node) => node.getAttribute("data-beat-visible") === "true")).toBe(true);
    expect(activeMarks()).toHaveLength(0);
  }

  it("plays one scripted turn per scenario and rests before rotation", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    expect(deck().dataset.beat).toBe("rest");
    expect(deck().dataset.playing).toBe("true");
    const ownBubble = () => activeCell().querySelector('[data-testid="landing-own-message"]')?.closest("[data-beat-visible]");
    expect(ownBubble()?.getAttribute("data-beat-visible")).toBe("false");
    expect(deck().querySelector('[data-testid="landing-composer-mic"]')).not.toBeNull();

    await advance(120);
    expect(deck().dataset.beat).toBe("typing");
    expect(typedPrompt().length).toBeGreaterThan(0);
    expect(deck().querySelector('[data-testid="landing-composer-send"]')).not.toBeNull();
    await advance(1440);
    expect(deck().dataset.beat).toBe("send");
    expect(typedPrompt()).toBe(SESSION_SCENARIOS[0].prompt);

    await advance(140);
    expect(deck().dataset.beat).toBe("own");
    expect(ownBubble()?.getAttribute("data-beat-visible")).toBe("true");
    expect(typedPrompt()).toBe("");

    await advance(200);
    expect(deck().dataset.beat).toBe("thinking");
    expect(activeMarks()).toHaveLength(1);
    expect(deck().querySelectorAll(".instafy-status-sweep")).toHaveLength(1);

    await advance(450);
    expect(deck().dataset.beat).toBe("step1");
    expect(deck().querySelector('[data-testid="landing-run-caption"]')?.textContent).toBe("Calling tool…");
    expect(deck().querySelectorAll(".instafy-compact-event-pill-live")).toHaveLength(1);

    await advance(2500);
    expect(deck().dataset.beat).toBe("done");
    expect(activeMarks()).toHaveLength(0);
    expect(deck().querySelectorAll(".instafy-status-sweep")).toHaveLength(0);
    expect(deck().querySelectorAll(".instafy-compact-event-pill-live")).toHaveLength(0);
    expect(deck().querySelector('[data-testid="landing-summary"]')?.getAttribute("data-beat-visible")).toBe("true");

    const diffCard = () => deck().querySelector('[data-testid="landing-diff-card"]')?.closest("[data-beat-visible]");
    await advance(600);
    expect(deck().dataset.beat).toBe("counts");
    // Octo's message is still assembling, so Kim has not started typing.
    expect(deck().querySelector('[data-testid="landing-kim-typing"]')).toBeNull();
    expect(diffCard()?.getAttribute("data-beat-visible")).toBe("false");

    await advance(400);
    expect(deck().dataset.beat).toBe("artifact");
    expect(diffCard()?.getAttribute("data-beat-visible")).toBe("true");
    expect(deck().querySelector('[data-testid="landing-kim-typing"]')).toBeNull();

    await advance(800);
    expect(deck().dataset.beat).toBe("kimTyping");
    expect(deck().querySelector('[data-testid="landing-kim-typing"]')).not.toBeNull();
    expect(deck().querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);

    await advance(750);
    expect(deck().dataset.beat).toBe("reply");
    expect(deck().querySelector('[data-testid="landing-kim-typing"]')).toBeNull();
    expect(deck().querySelector('[data-testid="landing-kim-reply"]')?.getAttribute("data-beat-visible")).toBe("true");
    expect(deck().querySelectorAll(".animate-pulse")).toHaveLength(0);

    // The finished frame is what the card is for, so it holds the longest.
    await advance(3000);
    expect(deck().dataset.beat).toBe("reply");
    expect(activeExample()).toBe("code");

    await advance(600);
    expect(activeExample()).toBe("books");
    expect(deck().dataset.beat).toBe("rest");
    expect(typedPrompt()).toBe("");
    expect(ownBubble()?.getAttribute("data-beat-visible")).toBe("false");

    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lands on the finished frame when offscreen or hidden", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    await advance(3000);
    expect(deck().dataset.beat).toBe("step2");

    await setVisible(false);
    expectFinishedFrame();
    await setVisible(true);
    expect(deck().dataset.beat).toBe("rest");

    await advance(3000);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expectFinishedFrame();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(deck().dataset.beat).toBe("rest");
  });

  it("shows the finished frame from the first render under reduced motion", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    await mount();
    expectFinishedFrame();
    await setVisible(true);
    await advance(3000);
    expectFinishedFrame();
    await act(async () => button("Launch a site").click());
    expectFinishedFrame();
    expect(shownText()).toContain("The pricing page is up at forma.site/pricing");
  });

  it("keeps every control outside the window", async () => {
    await mount();
    expect(
      deck().querySelectorAll(
        'a, button, input, textarea, select, [tabindex], [role="button"], [role="status"], [role="alert"], [aria-live]:not([aria-live="off"])',
      ),
    ).toHaveLength(0);
    const rootNode = container.querySelector('[data-testid="landing-session-deck-root"]') as HTMLElement;
    const controls = Array.from(rootNode.querySelectorAll("button, a[href]")).map((node) => node.textContent?.trim());
    expect(controls).toEqual(["Build a feature", "Close the books", "Launch a site", "Start your own session ↗"]);
  });

  it("names the chats and the person in the rail and the agent in the run", async () => {
    vi.useFakeTimers();
    await mount();
    const rail = deck().querySelector('[data-testid="landing-rail"]') as HTMLElement;
    expect(rail.getAttribute("aria-hidden")).toBe("true");
    for (const text of ["Launch week", "Forma", "Checkout flow", "February close", "Pricing page", "Browse all chats", "Ada", "ada@forma.site"]) {
      expect(rail.textContent).toContain(text);
    }
    const running = () => (rail.textContent?.match(/Running/g) ?? []).length;
    expect(running()).toBe(0);
    await setVisible(true);
    await advance(2200);
    expect(running()).toBe(1);
    expect(deck().querySelector('[data-testid="landing-run-caption"]')).toBeNull();
    await advance(1800);
    expect(deck().querySelector('[data-testid="landing-owner-badge"]')?.textContent).toBe("canary");
    await advance(850);
    expect(deck().dataset.beat).toBe("done");
    expect(running()).toBe(0);

    await act(async () => button("Close the books").click());
    const selected = Array.from(rail.querySelectorAll('[data-testid="landing-rail-chat"]')).filter(
      (node) => node.getAttribute("data-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("February close");
    expect(selected[0].classList.contains("bg-white")).toBe(true);
    expect(shownText()).toContain("Ledger");
    expect(shownText()).not.toContain("Canary");
  });

  it("has no em dashes in any scenario copy or rendered text", async () => {
    expect(JSON.stringify(SESSION_SCENARIOS)).not.toMatch(/\u2014/);
    await mount();
    for (const label of ["Build a feature", "Close the books", "Launch a site"]) {
      await act(async () => button(label).click());
      expect(container.textContent).not.toMatch(/\u2014/);
    }
  });
});
