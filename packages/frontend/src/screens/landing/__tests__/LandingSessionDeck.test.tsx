// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BEAT, BROWSER_TURN_BEATS, TURN_BEATS as WORKSPACE_BEATS, beatIndex } from "../landingTurnScript";
import { FIRST_TURN_HOLD_MS, rotateIntervalFor, turnBeatTimes } from "../useLandingScenarioDeck";
import {
  LandingScenarioChips,
  LandingSessionDeck,
  MANUAL_HOLD_MS,
  ROTATE_INTERVAL_MS,
  SESSION_SCENARIOS,
  TURN_BEATS,
  useLandingScenarioDeck,
  type LandingScenarioDeckState,
} from "../LandingSessionDeck";

// The hero renders the chips and the window apart from each other, both from
// one shared state; the harness does the same.
function DeckHarness({ onDeck, holdFirstTurn = false }: { onDeck?: (deck: LandingScenarioDeckState) => void; holdFirstTurn?: boolean }) {
  const deck = useLandingScenarioDeck({ holdFirstTurn });
  onDeck?.(deck);
  return (
    <>
      <LandingScenarioChips deck={deck} />
      <div data-testid="harness-gap" />
      <LandingSessionDeck deck={deck} joinToFor={(scenario) => `/login?example=${scenario.id}`} />
    </>
  );
}

describe("landing workspace example", () => {
  let container: HTMLDivElement;
  let root: Root;
  let intersect: IntersectionObserverCallback;
  let observer: IntersectionObserver;
  const disconnect = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    disconnect.mockReset();
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

  let latest: LandingScenarioDeckState | null = null;

  async function mount({ holdFirstTurn = false }: { holdFirstTurn?: boolean } = {}) {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <DeckHarness onDeck={(state) => (latest = state)} holdFirstTurn={holdFirstTurn} />
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

  function chipsGroup(): HTMLElement {
    return container.querySelector('[data-testid="landing-scenario-chips"]') as HTMLElement;
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
    // Not the leading scenario, so the selection is visibly a choice.
    const code = button("Build a feature");
    expect(code.type).toBe("button");
    await act(async () => code.focus());
    expect(document.activeElement).toBe(code);
    await act(async () => code.click());

    expect(code.getAttribute("aria-pressed")).toBe("true");
    expect(button("Close the books").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelectorAll('[aria-label$=" conversation"]')).toHaveLength(1);
    expect(shownText()).toContain(SESSION_SCENARIOS[1].prompt);
    expect(shownText()).not.toContain(SESSION_SCENARIOS[0].prompt);
    // The scenario's own agent, whose roster coin follows the scenario, is
    // named in the space so the name has a referent on the page.
    expect(shownText()).toContain(SESSION_SCENARIOS[1].presenceAgent);
    expect(shownText()).not.toContain(SESSION_SCENARIOS[0].presenceAgent);
    expect(container.querySelector('[data-testid="landing-join-session-button"]')?.getAttribute("href")).toBe("/login?example=code");
    expect(latest?.scenario).toBe(SESSION_SCENARIOS[1]);

    await advance(20_000);
    expect(activeExample()).toBe("code");
    await act(async () => button("Launch a site").click());
    expect(shownText()).toContain(SESSION_SCENARIOS[2].summary);
    expect(shownText()).not.toContain("Checkout is its own package now");
    // The browser and the file beside the chat stand in for a screencast and
    // an editor, so the page and the notes they draw are decorative: none of
    // their copy is exposed as conversation content.
    expect(container.textContent).toContain("Choose Starter");
    expect(shownText()).not.toContain("Choose Starter");
    expect(shownText()).not.toContain("Simple plans. Room to grow.");
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

  it("holds the hero's first turn on its opener until it is released, and never for long", async () => {
    vi.useFakeTimers();
    await mount({ holdFirstTurn: true });
    await setVisible(true);
    const rootNode = container.querySelector('[data-testid="landing-session-deck-root"]') as HTMLElement;
    // The opener shows with no turn clock, and nothing rotates while it waits.
    expect(deck().getAttribute("data-beat")).toBe("rest");
    expect(deck().getAttribute("data-playing")).toBe("true");
    expect(latest?.turnStartedAt).toBeNull();
    expect(rootNode.getAttribute("data-rotating")).toBe("false");
    await advance(2_000);
    expect(deck().getAttribute("data-beat")).toBe("rest");

    await act(async () => latest!.releaseFirstTurn());
    expect(latest?.turnStartedAt).not.toBeNull();
    expect(rootNode.getAttribute("data-rotating")).toBe("true");
    await advance(TURN_BEATS[1].atMs);
    expect(deck().getAttribute("data-beat")).toBe("typing");
    // Rotation counts a full interval from the release.
    await advance(ROTATE_INTERVAL_MS - TURN_BEATS[1].atMs - 1);
    expect(activeExample()).toBe("books");
    await advance(1);
    expect(activeExample()).toBe("code");
    // Later turns never wait.
    expect(latest?.turnStartedAt).not.toBeNull();
  });

  it("opens on the sent prompt when the composer is below the fold, keeping the rest of the turn on its clock", async () => {
    vi.useFakeTimers();
    const rect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.hasAttribute("data-landing-composer")) return { x: 0, y: window.innerHeight + 300, width: 800, height: 60, top: window.innerHeight + 300, bottom: window.innerHeight + 360, left: 0, right: 800, toJSON: () => ({}) } as DOMRect;
      return rect.call(this);
    });
    await mount({ holdFirstTurn: true });
    await setVisible(true);
    expect(deck().getAttribute("data-beat")).toBe("rest");
    await act(async () => latest!.releaseFirstTurn());
    // No typing nobody would see: sent at once, the prompt shows 140 ms later.
    const startedAt = latest!.turnStartedAt;
    expect(startedAt).not.toBeNull();
    expect(deck().getAttribute("data-beat")).toBe("send");
    await advance(TURN_BEATS[BEAT.OWN].atMs - TURN_BEATS[BEAT.SEND].atMs);
    expect(deck().getAttribute("data-beat")).toBe("own");
    // From Octo's thinking on, every beat keeps its time on the turn clock.
    await advance(TURN_BEATS[BEAT.THINKING].atMs - (TURN_BEATS[BEAT.OWN].atMs - TURN_BEATS[BEAT.SEND].atMs) - 1);
    expect(deck().getAttribute("data-beat")).toBe("own");
    await advance(1);
    expect(deck().getAttribute("data-beat")).toBe("thinking");
    expect(latest!.turnStartedAt).toBe(startedAt);
    expect(turnBeatTimes(WORKSPACE_BEATS, true).slice(BEAT.THINKING)).toEqual(TURN_BEATS.slice(BEAT.THINKING).map((entry) => entry.atMs));
    expect(turnBeatTimes(WORKSPACE_BEATS, false)).toEqual(TURN_BEATS.map((entry) => entry.atMs));
    // The browser task keeps its own clock the same way.
    expect(turnBeatTimes(BROWSER_TURN_BEATS, true).slice(BEAT.THINKING)).toEqual(BROWSER_TURN_BEATS.slice(BEAT.THINKING).map((entry) => entry.atMs));
  });

  it("starts a held first turn on its own after FIRST_TURN_HOLD_MS, or at once on a pick", async () => {
    vi.useFakeTimers();
    await mount({ holdFirstTurn: true });
    await setVisible(true);
    await advance(FIRST_TURN_HOLD_MS - 1);
    expect(latest?.turnStartedAt).toBeNull();
    await advance(1);
    expect(latest?.turnStartedAt).not.toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    await mount({ holdFirstTurn: true });
    await setVisible(true);
    await act(async () => button("Launch a site").click());
    expect(activeExample()).toBe("site");
    expect(latest?.turnStartedAt).not.toBeNull();
  });

  it("paints its first frame without a fade: reveals transition only once the frame has settled", async () => {
    vi.useFakeTimers();
    await mount();
    // The first commit is unsettled, so the visibility check that follows it
    // swaps beats instantly.
    expect(deck().hasAttribute("data-deck-settled")).toBe(false);
    expect(deck().classList.contains("group/deck")).toBe(true);
    const reveal = container.querySelector("[data-beat-visible]") as HTMLElement;
    // No duration until the frame settles (a bare duration would transition every property).
    expect(reveal.className).toContain("duration-0");
    expect(reveal.className).toContain("group-data-[deck-settled]/deck:duration-200");
    expect(reveal.className).not.toMatch(/(^|\s)duration-200(\s|$)/);
    await advance(100);
    expect(deck().hasAttribute("data-deck-settled")).toBe(true);
  });

  it("advances on the rotation interval while visible and never moves focus", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    expect(activeExample()).toBe("books");
    expect(deck().parentElement?.getAttribute("data-rotating")).toBe("true");

    await advance(ROTATE_INTERVAL_MS - 1);
    expect(activeExample()).toBe("books");
    await advance(1);
    expect(activeExample()).toBe("code");
    expect(latest?.scenario).toBe(SESSION_SCENARIOS[1]);
    expect(button("Build a feature").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(document.body);

    await advance(ROTATE_INTERVAL_MS);
    expect(activeExample()).toBe("site");
    // The site scenario is a turn plus the browser handoff it asks for, so it
    // stays longer before the deck moves on.
    await advance(rotateIntervalFor(SESSION_SCENARIOS[2]) - 1);
    expect(activeExample()).toBe("site");
    await advance(1);
    expect(activeExample()).toBe("books");
    expect(container.querySelector('[data-testid="landing-join-session-button"]')?.getAttribute("href")).toBe("/login?example=books");
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
    expect(activeExample()).toBe("books");

    await act(async () => {
      rootNode.dispatchEvent(new Event("pointerout", { bubbles: true }));
    });
    expect(rootNode.getAttribute("data-rotating")).toBe("true");
    await advance(ROTATE_INTERVAL_MS - 1);
    expect(activeExample()).toBe("books");
    await advance(1);
    expect(activeExample()).toBe("code");

    const join = container.querySelector('[data-testid="landing-join-session-button"]') as HTMLAnchorElement;
    await act(async () => join.focus());
    expect(document.activeElement).toBe(join);
    expect(rootNode.getAttribute("data-rotating")).toBe("false");
    await advance(ROTATE_INTERVAL_MS * 3);
    expect(activeExample()).toBe("code");

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
    expect(activeExample()).toBe("site");
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
    await advance(rotateIntervalFor(SESSION_SCENARIOS[2]));
    expect(activeExample()).toBe("books");

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
    expect(activeExample()).toBe("code");
  });

  it("holds while keyboard focus is inside the deck", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    const rootNode = container.querySelector('[data-testid="landing-session-deck-root"]') as HTMLElement;
    const chip = button("Build a feature");

    // A Tab press happens on whatever was focused before, outside the deck.
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      chip.focus();
    });
    expect(document.activeElement).toBe(chip);
    expect(rootNode.getAttribute("data-rotating")).toBe("false");
    await advance(ROTATE_INTERVAL_MS * 3);
    expect(activeExample()).toBe("books");
    expect(document.activeElement).toBe(chip);

    await act(async () => chip.blur());
    expect(rootNode.getAttribute("data-rotating")).toBe("true");
  });

  it("does not rotate offscreen or in a hidden tab", async () => {
    vi.useFakeTimers();
    await mount();
    await advance(ROTATE_INTERVAL_MS * 2);
    expect(activeExample()).toBe("books");

    await setVisible(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(ROTATE_INTERVAL_MS * 2);
    expect(activeExample()).toBe("books");

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(ROTATE_INTERVAL_MS);
    expect(activeExample()).toBe("code");
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
    expect(activeExample()).toBe("books");
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
    expect(deck().dataset.finalBeat).toBe("true");
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
    expect(deck().querySelector('[data-testid="landing-run-line"]')?.textContent).toBe("Using a tool…");
    expect(deck().querySelectorAll(".instafy-status-sweep")).toHaveLength(1);

    await advance(2500);
    expect(deck().dataset.beat).toBe("done");
    expect(activeMarks()).toHaveLength(0);
    expect(deck().querySelectorAll(".instafy-status-sweep")).toHaveLength(0);
    expect(deck().querySelectorAll(".instafy-compact-event-pill-live")).toHaveLength(0);
    expect(deck().querySelector('[data-testid="landing-summary"]')?.getAttribute("data-beat-visible")).toBe("true");

    // The summary names the review file by reference; the file itself lands
    // as its card (Created, every row added) on the artifact beat, and beside
    // the chat in a split (landingPanes.test.ts).
    expect(deck().querySelector('[data-testid="landing-summary"]')?.textContent).toContain("18 of 21 bank rows");
    expect(deck().querySelector('[data-testid="landing-file-reference"]')?.textContent).toBe("ledger/2026-02-review.csv:2");
    expect(deck().querySelector('[data-testid="landing-diff-card"]')?.closest("[data-beat-visible]")?.getAttribute("data-beat-visible")).toBe("false");
    await advance(600);
    expect(deck().dataset.beat).toBe("counts");
    // Octo's message is still assembling, so Kim has not started typing.
    expect(deck().querySelector('[data-testid="landing-kim-typing"]')).toBeNull();
    expect(deck().querySelector('[data-testid="landing-file-chip"]')).not.toBeNull();

    await advance(400);
    expect(deck().dataset.beat).toBe("artifact");
    expect(deck().querySelector('[data-testid="landing-kim-typing"]')).toBeNull();
    const card = deck().querySelector('[data-testid="landing-diff-card"]');
    expect(card?.closest("[data-beat-visible]")?.getAttribute("data-beat-visible")).toBe("true");
    expect(card?.textContent).toContain("Created");
    expect(card?.textContent).toContain("+2026-02-04,Acme AB,-2140.00,duplicate?");

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
    expect(activeExample()).toBe("books");

    await advance(600);
    expect(activeExample()).toBe("code");
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
    expect(shownText()).toContain(SESSION_SCENARIOS[2].summary);
    expect(shownText()).toContain(SESSION_SCENARIOS[2].browser!.summary);
    // The browser rests in its final state: the page, Team chosen, Octo's
    // cursor still on its click (inside its 4 s linger, no ripple), Kim's
    // pointer by the comparison, and nothing moving (no glow or prompt).
    const browser = deck().querySelector('[data-testid="landing-browser-dock"]') as HTMLElement;
    expect(browser.dataset.browserPage).toBe("true");
    expect(browser.textContent).toContain("Team selected");
    expect(browser.querySelector('[data-testid="landing-browser-kim"]')?.getAttribute("data-at")).toBe("compare");
    expect(browser.querySelector('[data-testid="landing-browser-glow"]')).toBeNull();
    expect(browser.querySelector('[data-testid="landing-browser-cursor"]')).not.toBeNull();
    expect(browser.querySelector(".motion-safe\\:animate-ping")).toBeNull();
    expect(browser.querySelector('[data-testid="landing-browser-approval"]')).toBeNull();
    expect(browser.querySelector('[data-testid="landing-browser-starting"]')).toBeNull();
  });

  it("plays the site's turn and then the browser handoff it asks for, in order", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    await act(async () => button("Launch a site").click());
    const site = SESSION_SCENARIOS[2];
    const at = (id: Parameters<typeof beatIndex>[1]) => BROWSER_TURN_BEATS[beatIndex(site, id)].atMs;
    const browser = () => deck().querySelector('[data-testid="landing-browser-dock"]') as HTMLElement | null;
    const view = () => deck().dataset.view;
    const seen: string[] = [];
    let clock = 0;
    const until = async (id: Parameters<typeof beatIndex>[1]) => {
      await advance(at(id) - clock);
      clock = at(id);
      seen.push(deck().dataset.beat!);
    };

    // Octo's workspace run keeps the workspace turn's beats.
    await until("artifact");
    expect(deck().querySelector('[data-testid="landing-browser-request"]')?.textContent).toContain("Open browser and continue");
    expect(browser()).toBeNull();
    expect(view()).toBe("chat");

    // The card holds before Ada presses it; her press goes down in the chat first.
    await until("tap");
    expect(deck().querySelector('[data-testid="landing-browser-request-button"]')?.getAttribute("data-pressed")).toBe("true");
    expect(browser()).toBeNull();
    expect(view()).toBe("chat");

    // Ada's press opens the browser; one view brings it to the front.
    await until("press");
    expect(deck().querySelector('[data-testid="landing-browser-request-button"]')?.textContent).toBe("Opening browser…");
    expect(browser()?.querySelector('[data-testid="landing-browser-starting"]')?.textContent).toContain("Starting Shared Browser");
    expect(browser()?.querySelector('[data-testid="landing-browser-address"]')?.textContent).toContain("Connecting to Shared Browser…");
    expect(view()).toBe("browser");

    await until("handoff");
    expect(deck().querySelector('[data-testid="landing-continuation"]')?.closest("[data-beat-visible]")?.getAttribute("data-beat-visible")).toBe("true");
    expect(deck().querySelector('[data-testid="landing-browser-request-button"]')?.textContent).toBe("Open browser and continue");
    expect(browser()?.dataset.browserConnected).toBe("true");

    await until("browse");
    expect(deck().dataset.runLive).toBe("true");
    await until("approve");
    expect(browser()?.querySelector('[data-testid="landing-browser-approval"]')?.textContent).toContain("Octo wants to use");
    expect(browser()?.querySelector('[data-testid="landing-browser-allow"]')?.textContent).toBe("Allow site");
    await until("allowPress");
    expect(browser()?.querySelector('[data-testid="landing-browser-allow"]')?.className).toContain("scale-[0.98]");
    await until("allowed");
    expect(browser()?.querySelector('[data-testid="landing-browser-approval"]')).toBeNull();
    expect(browser()?.querySelector('[data-testid="landing-browser-glow"]')).not.toBeNull();
    await until("navigate");
    expect(browser()?.querySelector('[data-testid="landing-browser-ticker"]')?.textContent).toBe(`Go to ${site.browser!.url}`);
    await until("loaded");
    expect(browser()?.querySelector('[data-testid="landing-browser-ticker"]')?.textContent).toBe("Pricing · Forma");
    // Octo scrolls to the plans, then clicks, so its cursor stays on the button it clicked.
    await until("scroll");
    expect(browser()?.querySelector('[data-testid="landing-browser-ticker"]')?.textContent).toBe("Scroll");
    expect(browser()?.querySelector('[data-testid="landing-browser-cursor"]')).toBeNull();
    await until("click");
    expect(browser()?.querySelector('[data-testid="landing-browser-ticker"]')?.textContent).toBe('Click "Choose Team"');
    expect(browser()?.querySelector('[data-testid="landing-browser-cursor"]')).not.toBeNull();

    // Octo is done in the browser. Nothing in the studio switches back to
    // Chat on its own: in one view Ada's press goes down on the Chat tab, and
    // only then is the chat in front, with Kim typing.
    const chatTab = () => deck().querySelector('[data-testid="landing-views-segmented"] [data-view-id="chat"]') as HTMLElement | null;
    await until("browseDone");
    expect(deck().dataset.runLive).toBe("false");
    expect(view()).toBe("browser");
    expect(chatTab()?.dataset.pressed).toBe("true");
    expect(browser()?.querySelector('[data-testid="landing-browser-glow"]')).toBeNull();
    expect(deck().querySelector('[data-testid="landing-kim-typing"]')).toBeNull();
    await until("kimTyping");
    expect(view()).toBe("chat");
    expect(chatTab()?.dataset.pressed).toBeUndefined();
    expect(deck().querySelector('[data-testid="landing-kim-typing"]')).not.toBeNull();
    await until("reply");
    expect(browser()?.querySelector('[data-testid="landing-browser-cursor"]')).not.toBeNull();
    await until("settle");
    expect(browser()?.querySelector('[data-testid="landing-browser-cursor"]')).toBeNull();
    expect(view()).toBe("chat");
    expect(seen).toEqual([
      "artifact",
      "tap",
      "press",
      "handoff",
      "browse",
      "approve",
      "allowPress",
      "allowed",
      "navigate",
      "loaded",
      "scroll",
      "click",
      "browseDone",
      "kimTyping",
      "reply",
      "settle",
    ]);

    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
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
    expect(controls).toEqual(["Start your own session ↗"]);
    // The chips live apart from the window (in the hero), as one named group
    // whose buttons control the window's conversation.
    const group = chipsGroup();
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Choose a workspace example");
    expect(rootNode.contains(group)).toBe(false);
    const chips = Array.from(group.querySelectorAll("button"));
    expect(chips.map((node) => node.textContent?.trim())).toEqual(["Close the books", "Build a feature", "Launch a site"]);
    const conversation = deck().querySelector('section[aria-label$=" conversation"]') as HTMLElement;
    expect(conversation.id).not.toBe("");
    expect(chips.every((chip) => chip.getAttribute("aria-controls") === conversation.id)).toBe(true);
  });

  it("holds rotation while the pointer is over the chips or keyboard focus is on them", async () => {
    vi.useFakeTimers();
    await mount();
    await setVisible(true);
    const group = chipsGroup();
    const rootNode = container.querySelector('[data-testid="landing-session-deck-root"]') as HTMLElement;
    expect(group.getAttribute("data-rotating")).toBe("true");

    await act(async () => {
      group.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    expect(group.getAttribute("data-rotating")).toBe("false");
    expect(rootNode.getAttribute("data-rotating")).toBe("false");
    await advance(ROTATE_INTERVAL_MS * 3);
    expect(activeExample()).toBe("books");

    // Moving from the chips to the window keeps the hold.
    await act(async () => {
      rootNode.dispatchEvent(new Event("pointerover", { bubbles: true }));
      group.dispatchEvent(new Event("pointerout", { bubbles: true }));
    });
    expect(rootNode.getAttribute("data-rotating")).toBe("false");
    await act(async () => {
      rootNode.dispatchEvent(new Event("pointerout", { bubbles: true }));
    });
    expect(group.getAttribute("data-rotating")).toBe("true");
    await advance(ROTATE_INTERVAL_MS);
    expect(activeExample()).toBe("code");

    const chip = button("Launch a site");
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      chip.focus();
    });
    expect(group.getAttribute("data-rotating")).toBe("false");
    await advance(ROTATE_INTERVAL_MS * 3);
    expect(activeExample()).toBe("code");
    await act(async () => chip.blur());
    expect(group.getAttribute("data-rotating")).toBe("true");
  });

  it("names the chats and the person in the rail and the agent in the run", async () => {
    vi.useFakeTimers();
    await mount();
    const rail = deck().querySelector('[data-testid="landing-rail"]') as HTMLElement;
    expect(rail.getAttribute("aria-hidden")).toBe("true");
    for (const text of ["Finance", "Forma", "Checkout flow", "February close", "Pricing page", "Browse all chats", "Ada", "ada@forma.site"]) {
      expect(rail.textContent).toContain(text);
    }
    // The space is named plainly for the scenario on screen.
    expect(rail.textContent).not.toContain("Launch week");
    const running = () => (rail.textContent?.match(/Running/g) ?? []).length;
    expect(running()).toBe(0);
    await setVisible(true);
    await advance(2200);
    expect(running()).toBe(1);
    expect(deck().textContent).not.toContain("Calling tool…");
    await advance(1800);
    // Quill's step: the line names what it does, as the studio's line does.
    expect(deck().querySelector('[data-testid="landing-run-line"]')?.textContent).toBe("Using a tool…");
    await advance(850);
    expect(deck().dataset.beat).toBe("done");
    expect(running()).toBe(0);

    await act(async () => button("Build a feature").click());
    const selected = Array.from(rail.querySelectorAll('[data-testid="landing-rail-chat"]')).filter(
      (node) => node.getAttribute("data-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("Checkout flow");
    expect(selected[0].classList.contains("bg-white")).toBe(true);
    expect(rail.textContent).toContain("Checkout");
    expect(rail.textContent).not.toContain("Finance");
    expect(shownText()).toContain("Canary");
    expect(shownText()).not.toContain("Ledger");
  });

  it("has no em dashes in any scenario copy or rendered text", async () => {
    expect(JSON.stringify(SESSION_SCENARIOS)).not.toMatch(/\u2014/);
    await mount();
    for (const label of ["Build a feature", "Close the books", "Launch a site"]) {
      await act(async () => button(label).click());
      expect(container.textContent).not.toMatch(/\u2014/);
    }
  });
  // The hero's creature follows the turn from the beat timers' own clock.
  it("reports when the playing turn started and counts a visitor's picks", async () => {
    vi.useFakeTimers();
    await mount();
    expect(latest?.turnStartedAt).toBeNull();
    expect(latest?.picks).toBe(0);

    await setVisible(true);
    const first = latest?.turnStartedAt;
    expect(typeof first).toBe("number");
    // The beats count from that moment.
    await advance(TURN_BEATS[5].atMs);
    expect(latest?.turnStartedAt).toBe(first);
    expect(deck().getAttribute("data-beat")).toBe(TURN_BEATS[5].id);

    await act(async () => button("Launch a site").click());
    expect(latest?.picks).toBe(1);
    expect(latest?.turnStartedAt).not.toBe(first);

    // Not playing (offscreen): no turn.
    await setVisible(false);
    expect(latest?.turnStartedAt).toBeNull();
  });
});
