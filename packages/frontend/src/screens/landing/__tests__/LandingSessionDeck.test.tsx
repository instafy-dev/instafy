// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingSessionDeck, SESSION_SCENARIOS } from "../LandingSessionDeck";

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

  function button(label: string): HTMLButtonElement {
    const target = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === label);
    expect(target).toBeDefined();
    expect(target?.hasAttribute("aria-label")).toBe(false);
    return target!;
  }

  function activeMarks() {
    return container.querySelectorAll('[data-octo-motion="thinking"][data-octo-animated="true"]');
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
    expect(container.textContent).toContain(SESSION_SCENARIOS[1].prompt);
    expect(container.textContent).not.toContain(SESSION_SCENARIOS[0].prompt);
    expect(container.querySelector('[data-testid="landing-join-session-button"]')?.getAttribute("href")).toBe("/login?example=books");
    expect(scenarioChanged).toHaveBeenLastCalledWith(SESSION_SCENARIOS[1]);

    await act(async () => vi.advanceTimersByTime(20_000));
    expect(container.querySelector('[data-testid="landing-session-deck"]')?.getAttribute("data-example")).toBe("books");
    await act(async () => button("Launch a site").click());
    expect(container.textContent).toContain("Room for your next idea.");
    expect(container.textContent).not.toContain("February reconciliation");
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
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    await mount();
    await setVisible(true);
    expect(activeMarks()).toHaveLength(0);
    expect(container.querySelectorAll("animate, animateTransform")).toHaveLength(0);
    await act(async () => button("Launch a site").click());
    expect(container.textContent).toContain(SESSION_SCENARIOS[2].prompt);
    expect(activeMarks()).toHaveLength(0);
  });
});
