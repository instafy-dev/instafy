// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsShell, type SettingsCategory } from "../SettingsShell";

const categories: SettingsCategory[] = [
  { id: "overview", label: "Overview" },
  { id: "people", label: "People" },
  {
    id: "voice",
    label: "Voice & audio",
    children: [
      { id: "speech", label: "Speech provider" },
      { id: "audio", label: "Host audio" },
    ],
  },
];

describe("SettingsShell available-pane navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let paneWidth: number;
  let viewportWidth: number;
  const onCategoryChange = vi.fn();
  const onChildCategoryChange = vi.fn();
  const mediaQueries = new Map<string, {
    matches: boolean;
    listeners: Set<(event: MediaQueryListEvent) => void>;
  }>();
  const observers: Array<{
    targets: Set<Element>;
    notify: () => void;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];

  function Harness({ initialCategory = "people", personal = false }: { initialCategory?: string; personal?: boolean }) {
    const [category, setCategory] = useState(initialCategory);
    const [childCategory, setChildCategory] = useState("speech");
    return (
      <SettingsShell
        title={personal ? "Your settings" : "Space settings"}
        categories={personal ? [
          { id: "account", label: "Profile" },
          { id: "preferences", label: "Preferences" },
          { id: "notifications", label: "Notifications" },
        ] : categories}
        compactCategoryNavigation={personal ? "tabs" : "picker"}
        activeCategoryId={category}
        activeChildCategoryId={childCategory}
        onCategoryChange={(next) => {
          onCategoryChange(next);
          setCategory(next);
        }}
        onChildCategoryChange={(next) => {
          onChildCategoryChange(next);
          setChildCategory(next);
        }}
      >
        <p data-testid="active-content">{category === "voice" ? `${category}:${childCategory}` : category}</p>
        <input aria-label="Example setting" data-testid="settings-field" />
      </SettingsShell>
    );
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    paneWidth = 1080;
    viewportWidth = 1440;
    mediaQueries.clear();
    observers.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    vi.stubGlobal("matchMedia", vi.fn((query: string) => {
      let state = mediaQueries.get(query);
      if (!state) {
        state = {
          matches: viewportWidth >= Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? Infinity),
          listeners: new Set(),
        };
        mediaQueries.set(query, state);
      }
      const current = state;
      return {
        get matches() { return current.matches; },
        media: query,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => current.listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => current.listeners.delete(listener),
        addListener: (listener: (event: MediaQueryListEvent) => void) => current.listeners.add(listener),
        removeListener: (listener: (event: MediaQueryListEvent) => void) => current.listeners.delete(listener),
      };
    }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("data-testid") === "settings-shell"
        ? new DOMRect(0, 0, paneWidth, 800)
        : new DOMRect(0, 0, 100, 40);
    });
    vi.stubGlobal("ResizeObserver", class {
      targets = new Set<Element>();
      disconnect = vi.fn(() => this.targets.clear());
      constructor(callback: ResizeObserverCallback) {
        observers.push({
          targets: this.targets,
          disconnect: this.disconnect,
          notify: () => callback([], this as unknown as ResizeObserver),
        });
      }
      observe(target: Element) { this.targets.add(target); }
      unobserve(target: Element) { this.targets.delete(target); }
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const get = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  async function render(initialCategory?: string) {
    await act(async () => root.render(<Harness initialCategory={initialCategory} />));
  }

  async function resizePane(width: number) {
    paneWidth = width;
    const shell = get("settings-shell");
    const shellObservers = observers.filter((observer) => shell && observer.targets.has(shell));
    expect(shellObservers.length).toBeGreaterThan(0);
    await act(async () => shellObservers.forEach((observer) => observer.notify()));
  }

  async function resizeViewport(width: number) {
    viewportWidth = width;
    await act(async () => {
      mediaQueries.forEach((state, query) => {
        const matches = viewportWidth >= Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? Infinity);
        if (matches === state.matches) return;
        state.matches = matches;
        state.listeners.forEach((listener) => listener({ matches, media: query } as MediaQueryListEvent));
      });
    });
  }

  async function click(testId: string) {
    const element = get(testId);
    expect(element).not.toBeNull();
    await act(async () => element?.click());
  }

  it("replaces the category column when a wide viewport's pane shrinks and restores the current selection", async () => {
    await render();
    expect(get("settings-category-nav")).not.toBeNull();
    expect(get("settings-category-people")?.getAttribute("aria-current")).toBe("page");

    await resizePane(412);
    expect(get("settings-category-nav")).toBeNull();
    expect(get("settings-category-nav-picker")?.textContent).toContain("People");
    expect(get("active-content")?.textContent).toBe("people");
    expect(onCategoryChange).not.toHaveBeenCalled();

    await click("settings-category-nav-picker");
    await click("settings-category-overview");
    expect(onCategoryChange).toHaveBeenCalledWith("overview");
    expect(get("active-content")?.textContent).toBe("overview");

    await resizePane(1080);
    expect(get("settings-category-nav-picker")).toBeNull();
    expect(get("settings-category-overview")?.getAttribute("aria-current")).toBe("page");
    expect(get("settings-category-people")?.hasAttribute("aria-current")).toBe(false);
  });

  it("shows all three personal categories on a phone and selects the existing account route", async () => {
    viewportWidth = 390;
    paneWidth = 390;
    await act(async () => root.render(<Harness initialCategory="preferences" personal />));
    expect(get("settings-category-nav-tabs")).not.toBeNull();
    expect(get("settings-category-nav-picker")).toBeNull();
    expect([...get("settings-category-nav-tabs")!.querySelectorAll("button")].map(button => button.textContent)).toEqual([
      "Profile", "Preferences", "Notifications",
    ]);
    expect(get("settings-category-preferences")?.getAttribute("aria-current")).toBe("page");
    await click("settings-category-account");
    expect(onCategoryChange).toHaveBeenCalledExactlyOnceWith("account");
    expect(get("active-content")?.textContent).toBe("account");
    expect(get("settings-category-account")?.getAttribute("aria-current")).toBe("page");
  });

  it("keeps focus on the selected personal category across the sidebar and compact tabs", async () => {
    await act(async () => root.render(<Harness initialCategory="notifications" personal />));
    expect(get("settings-category-nav")).not.toBeNull();
    await act(async () => get("settings-category-notifications")?.focus());
    await resizePane(390);
    expect(get("settings-category-nav-tabs")).not.toBeNull();
    expect(document.activeElement).toBe(get("settings-category-notifications"));
    await click("settings-category-preferences");
    await act(async () => get("settings-category-preferences")?.focus());
    await resizePane(1080);
    expect(get("settings-category-nav-tabs")).toBeNull();
    expect(document.activeElement).toBe(get("settings-category-preferences"));
    expect(get("active-content")?.textContent).toBe("preferences");
  });

  it("measures a shell revealed after an initially hidden layout without resetting its category", async () => {
    paneWidth = 0;
    await render();
    expect(get("settings-category-nav")).toBeNull();
    await resizePane(1080);
    expect(get("settings-category-nav")).not.toBeNull();
    expect(get("settings-category-people")?.getAttribute("aria-current")).toBe("page");
    expect(onCategoryChange).not.toHaveBeenCalled();
  });

  it("keeps the category column only at or above the minimum usable pane width", async () => {
    paneWidth = 767;
    await render();
    expect(get("settings-category-nav")).toBeNull();
    await resizePane(768);
    expect(get("settings-category-nav")).not.toBeNull();
  });

  it("uses the picker below the Studio desktop breakpoint even when the pane fits a category column", async () => {
    viewportWidth = 899;
    paneWidth = 850;
    await render();
    expect(get("settings-category-nav")).toBeNull();
    expect(get("settings-category-nav-picker")).not.toBeNull();
  });

  it("selects a wide-layout category through the caller and exposes the current destination", async () => {
    await render();
    await click("settings-category-overview");
    expect(onCategoryChange).toHaveBeenCalledExactlyOnceWith("overview");
    expect(get("active-content")?.textContent).toBe("overview");
    expect(get("settings-category-overview")?.getAttribute("aria-current")).toBe("page");
  });

  it("keeps keyboard focus in navigation when its presentation changes", async () => {
    await render();
    await act(async () => get("settings-category-people")?.focus());
    await resizePane(412);
    expect(document.activeElement).toBe(get("settings-category-nav-picker"));
    await resizePane(1080);
    expect(document.activeElement).toBe(get("settings-category-people"));
  });

  it("does not take focus away from a setting when the navigation layout changes", async () => {
    await render();
    await act(async () => get("settings-field")?.focus());
    await resizePane(412);
    expect(document.activeElement).toBe(get("settings-field"));
    await resizePane(1080);
    expect(document.activeElement).toBe(get("settings-field"));
  });

  it("hands off navigation focus across the viewport breakpoint without a pane-width change", async () => {
    paneWidth = 850;
    await render();
    await act(async () => get("settings-category-people")?.focus());
    await resizeViewport(899);
    expect(get("settings-category-nav")).toBeNull();
    expect(document.activeElement).toBe(get("settings-category-nav-picker"));
    await resizeViewport(900);
    expect(document.activeElement).toBe(get("settings-category-people"));
  });

  it("does not restore stale navigation focus after the user moves to a field or blurs", async () => {
    paneWidth = 850;
    await render();
    await act(async () => {
      get("settings-category-people")?.focus();
      get("settings-field")?.focus();
    });
    await resizeViewport(899);
    expect(document.activeElement).toBe(get("settings-field"));
    await act(async () => {
      get("settings-category-nav-picker")?.focus();
      get("settings-category-nav-picker")?.blur();
    });
    expect(document.activeElement).toBe(document.body);
    await resizeViewport(900);
    expect(document.activeElement).toBe(document.body);
  });

  it("returns focus to the selected child rather than its parent after a presentation change", async () => {
    await render("voice");
    await click("settings-category-voice-audio");
    await act(async () => get("settings-category-voice-audio")?.focus());
    await resizePane(412);
    expect(document.activeElement).toBe(get("settings-category-nav-child-picker"));
    await resizePane(1080);
    expect(document.activeElement).toBe(get("settings-category-voice-audio"));
  });

  it("preserves a selected child while changing presentation and identifies the parent location separately", async () => {
    await render("voice");
    await click("settings-category-voice-audio");
    expect(onChildCategoryChange).toHaveBeenCalledExactlyOnceWith("audio");
    expect(get("settings-category-voice")?.getAttribute("aria-current")).toBe("location");
    expect(get("settings-category-voice-audio")?.getAttribute("aria-current")).toBe("page");

    await resizePane(412);
    expect(get("settings-category-nav-picker")?.textContent).toContain("Voice & audio");
    expect(get("settings-category-nav-child-picker")?.textContent).toContain("Host audio");
    expect(get("active-content")?.textContent).toBe("voice:audio");

    await resizePane(1080);
    expect(get("settings-category-voice-audio")?.getAttribute("aria-current")).toBe("page");
    expect(onCategoryChange).not.toHaveBeenCalled();
    expect(onChildCategoryChange).toHaveBeenCalledTimes(1);
  });

  it("disconnects its size observer when the settings shell unmounts", async () => {
    await render();
    const shell = get("settings-shell");
    const shellObserver = observers.find((observer) => shell && observer.targets.has(shell));
    expect(shellObserver).toBeDefined();
    await act(async () => root.render(null));
    expect(shellObserver?.disconnect).toHaveBeenCalledOnce();
    expect(shellObserver?.targets.size).toBe(0);
  });
});
