// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SettingsShell, type SettingsCategory } from "../SettingsShell";
import { SettingsSection } from "../SettingsSection";
import { useSettingsRoute } from "../../settingsRoute";

const { nativeBack } = vi.hoisted(() => ({ nativeBack: vi.fn() }));
vi.mock("../../../../native/useNativeBackButtonAction", () => ({ useNativeBackButtonAction: nativeBack }));

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
    disconnect: Mock;
  }> = [];

  function Harness({ initialCategory = "people", personal = false, sectionHeading = false }: { initialCategory?: string; personal?: boolean; sectionHeading?: boolean }) {
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
        activeCategoryId={category}
        activeChildCategoryId={childCategory}
        onCategoryChange={(next, child) => {
          if (child) {
            onCategoryChange(next, child);
            setChildCategory(child);
          } else onCategoryChange(next);
          setCategory(next);
        }}
        onChildCategoryChange={(next) => {
          onChildCategoryChange(next);
          setChildCategory(next);
        }}
      >
        {sectionHeading ? <>
          <SettingsSection title={personal ? "Preferences" : category === "voice" ? "Speech provider" : "People"}
            description="Keep this helper text." actions={<button>Save section</button>} data-testid="current-section">
            <input aria-label="Section field" />
          </SettingsSection>
          <SettingsSection title="Other options" data-testid="other-section"><p>Other settings</p></SettingsSection>
        </> : null}
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

  it("visually suppresses only the matching picker heading and restores it beside a wide category list", async () => {
    await act(async () => root.render(<Harness sectionHeading />));
    const heading = () => get("current-section")!.querySelector("h3")!;
    expect(heading().classList.contains("sr-only")).toBe(false);
    await resizePane(390);
    expect(get("settings-category-nav-picker")?.textContent).toContain("People");
    expect(heading().classList.contains("sr-only")).toBe(true);
    expect(heading().hasAttribute("aria-hidden")).toBe(false);
    expect(get("current-section")?.textContent).toContain("Keep this helper text.");
    expect(get("current-section")?.querySelector("button")?.textContent).toBe("Save section");
    expect(get("other-section")?.querySelector("h3")?.classList.contains("sr-only")).toBe(false);
    await resizePane(1080);
    expect(heading().classList.contains("sr-only")).toBe(false);
  });

  it("matches a nested picker's selected leaf on mobile", async () => {
    paneWidth = 390;
    viewportWidth = 390;
    await act(async () => root.render(<Harness initialCategory="voice" sectionHeading />));
    expect(get("settings-category-nav-picker")?.textContent).toContain("Speech provider");
    expect(get("current-section")?.querySelector("h3")?.classList.contains("sr-only")).toBe(true);
    expect(get("other-section")?.querySelector("h3")?.classList.contains("sr-only")).toBe(false);
  });

  it("retains content headings below compact tabs", async () => {
    paneWidth = 390;
    viewportWidth = 390;
    await act(async () => root.render(<Harness initialCategory="preferences" personal sectionHeading />));
    expect(get("settings-category-nav-tabs")).not.toBeNull();
    expect(get("current-section")?.querySelector("h3")?.classList.contains("sr-only")).toBe(false);
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
    expect(document.activeElement).toBe(get("settings-category-nav-picker"));
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
    expect(get("settings-category-nav-picker")?.textContent).toContain("Host audio");
    expect(get("settings-category-nav-child-picker")).toBeNull();
    expect(get("active-content")?.textContent).toBe("voice:audio");

    await resizePane(1080);
    expect(get("settings-category-voice-audio")?.getAttribute("aria-current")).toBe("page");
    expect(onCategoryChange).not.toHaveBeenCalled();
    expect(onChildCategoryChange).toHaveBeenCalledTimes(1);
  });


  it("browses nested categories in one picker and commits only the selected destination", async () => {
    paneWidth = 390;
    viewportWidth = 390;
    await render();
    await click("settings-category-nav-picker");
    await click("settings-category-voice");
    expect(get("settings-category-nav-popover")).not.toBeNull();
    expect(get("settings-category-nav-child-picker")).toBeNull();
    expect(get("settings-category-nav-back")).not.toBeNull();
    expect(get("active-content")?.textContent).toBe("people");
    expect(onCategoryChange).not.toHaveBeenCalled();
    expect(onChildCategoryChange).not.toHaveBeenCalled();
    await click("settings-category-voice-audio");
    expect(onCategoryChange).toHaveBeenCalledExactlyOnceWith("voice", "audio");
    expect(onChildCategoryChange).not.toHaveBeenCalled();
    expect(get("active-content")?.textContent).toBe("voice:audio");
    expect(get("settings-category-nav-popover")).toBeNull();
    expect(get("settings-category-nav-picker")?.getAttribute("aria-label")).toBe("Categories: Voice & audio / Host audio");
  });

  it("opens the current subsection and returns to all categories without changing the route", async () => {
    paneWidth = 390;
    viewportWidth = 390;
    await render("voice");
    await click("settings-category-nav-picker");
    expect(get("settings-category-voice-speech")).not.toBeNull();
    expect(get("settings-category-overview")).toBeNull();
    await click("settings-category-nav-back");
    expect(get("settings-category-overview")).not.toBeNull();
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(get("settings-category-voice"));
    expect(get("settings-category-nav-back")).toBeNull();
    expect(get("active-content")?.textContent).toBe("voice:speech");
    expect(onCategoryChange).not.toHaveBeenCalled();
    expect(onChildCategoryChange).not.toHaveBeenCalled();
    await click("settings-category-overview");
    expect(onCategoryChange).toHaveBeenCalledExactlyOnceWith("overview");
  });

  it("selects another child through the existing active-parent callback", async () => {
    paneWidth = 390;
    await render("voice");
    await click("settings-category-nav-picker");
    await click("settings-category-voice-audio");
    expect(onChildCategoryChange).toHaveBeenCalledExactlyOnceWith("audio");
    expect(onCategoryChange).not.toHaveBeenCalled();
    expect(get("active-content")?.textContent).toBe("voice:audio");
  });

  it("uses Escape to return a picker level before dismissing and restoring trigger focus", async () => {
    paneWidth = 390;
    await render("voice");
    await act(async () => get("settings-category-nav-picker")?.focus());
    await click("settings-category-nav-picker");
    await act(async () => get("settings-category-voice-audio")?.focus());
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(get("settings-category-nav-popover")).not.toBeNull();
    expect(get("settings-category-nav-back")).toBeNull();
    expect(get("active-content")?.textContent).toBe("voice:speech");
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(get("settings-category-nav-popover")).toBeNull();
    expect(document.activeElement).toBe(get("settings-category-nav-picker"));
    expect(onCategoryChange).not.toHaveBeenCalled();
  });


  it("uses native Back to leave a subsection before closing the picker", async () => {
    paneWidth = 390;
    await render("voice");
    await act(async () => get("settings-category-nav-picker")?.focus());
    await click("settings-category-nav-picker");
    const back = () => {
      const latest = [...nativeBack.mock.calls].reverse().find(([enabled, , priority]) => enabled && priority === 240);
      expect(latest).toBeDefined();
      latest![1]();
    };
    await act(async () => back());
    expect(get("settings-category-nav-popover")).not.toBeNull();
    expect(get("settings-category-nav-back")).toBeNull();
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(get("settings-category-voice"));
    expect(onCategoryChange).not.toHaveBeenCalled();
    await act(async () => back());
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(get("settings-category-nav-popover")).toBeNull();
    expect(document.activeElement).toBe(get("settings-category-nav-picker"));
    expect(onCategoryChange).not.toHaveBeenCalled();
    expect(onChildCategoryChange).not.toHaveBeenCalled();
  });


  it.each(["button", "Escape", "native"] as const)("returns focus to the browsed inactive parent with %s Back", async method => {
    paneWidth = 390;
    await render("overview");
    await act(async () => get("settings-category-nav-picker")?.focus());
    await click("settings-category-nav-picker");
    await click("settings-category-voice");
    await act(async () => get("settings-category-voice-audio")?.focus());
    if (method === "button") await click("settings-category-nav-back");
    else if (method === "Escape") {
      await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    } else {
      const latest = [...nativeBack.mock.calls].reverse().find(([enabled, , priority]) => enabled && priority === 240);
      expect(latest).toBeDefined();
      await act(async () => latest![1]());
    }
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(get("settings-category-voice"));
    expect(get("settings-category-overview")?.getAttribute("aria-checked")).toBe("true");
    expect(get("settings-category-voice")?.getAttribute("aria-checked")).toBe("false");
    expect(get("active-content")?.textContent).toBe("overview");
    expect(onCategoryChange).not.toHaveBeenCalled();
    expect(onChildCategoryChange).not.toHaveBeenCalled();
  });

  it("closes an open picker on resize and restores focus to the current desktop subsection", async () => {
    paneWidth = 390;
    await render("voice");
    await click("settings-category-nav-picker");
    await act(async () => get("settings-category-voice-speech")?.focus());
    await resizePane(1080);
    expect(get("settings-category-nav-popover")).toBeNull();
    expect(document.activeElement).toBe(get("settings-category-voice-speech"));
    expect(get("active-content")?.textContent).toBe("voice:speech");
    expect(onCategoryChange).not.toHaveBeenCalled();
  });

  it("shows small flat category sets as visible tabs by default", async () => {
    paneWidth = 390;
    await act(async () => root.render(
      <SettingsShell title="Team credits" categories={[{ id: "activity", label: "Activity" }, { id: "plans", label: "Plans" }, { id: "usage", label: "Usage" }]}
        activeCategoryId="plans" onCategoryChange={onCategoryChange}><p>Body</p></SettingsShell>
    ));
    expect(get("settings-category-nav-tabs")).not.toBeNull();
    expect(get("settings-category-nav-picker")).toBeNull();
    expect(get("settings-category-plans")?.getAttribute("aria-current")).toBe("page");
    await click("settings-category-usage");
    expect(onCategoryChange).toHaveBeenCalledExactlyOnceWith("usage");
  });


  it("keeps an unavailable selected subsection visible while blocking disabled destinations", async () => {
    paneWidth = 390;
    const unavailableCategories: SettingsCategory[] = [
      { id: "overview", label: "Overview" },
      { id: "voice", label: "Voice & audio", children: [
        { id: "speech", label: "Speech provider", disabled: true },
        { id: "audio", label: "Host audio" },
      ] },
    ];
    await act(async () => root.render(
      <SettingsShell title="Space settings" categories={unavailableCategories} activeCategoryId="voice" activeChildCategoryId="speech"
        onCategoryChange={onCategoryChange} onChildCategoryChange={onChildCategoryChange}><p>Body</p></SettingsShell>
    ));
    expect(get("settings-category-nav-picker")?.textContent).toContain("Speech provider");
    await click("settings-category-nav-picker");
    expect(get("settings-category-voice-speech")?.getAttribute("aria-disabled")).toBe("true");
    await click("settings-category-voice-speech");
    expect(onChildCategoryChange).not.toHaveBeenCalled();
    expect(get("settings-category-nav-popover")).not.toBeNull();
    await click("settings-category-voice-audio");
    expect(onChildCategoryChange).toHaveBeenCalledExactlyOnceWith("audio");
  });

  it("commits a nested destination as one URL visit and restores it with Back and Forward", async () => {
    paneWidth = 390;
    function RoutedSettings() {
      const route = useSettingsRoute("project");
      const location = useLocation();
      const navigate = useNavigate();
      return <>
        <SettingsShell title="Space settings" categories={[
          { id: "overview", label: "Overview" },
          { id: "ai", label: "Voice & audio", children: [{ id: "speech", label: "Speech provider" }, { id: "audio", label: "Host audio" }] },
        ]} activeCategoryId={route.category} activeChildCategoryId={route.itemId}
          onCategoryChange={route.selectSection}
          onChildCategoryChange={route.category === "ai" ? itemId => route.selectSection("ai", itemId) : undefined}>
          <p data-testid="route-state">{JSON.stringify({ key: location.key, category: route.category, itemId: route.itemId })}</p>
        </SettingsShell>
        <button data-testid="browser-back" onClick={() => navigate(-1)}>Browser Back</button>
        <button data-testid="browser-forward" onClick={() => navigate(1)}>Browser Forward</button>
      </>;
    }
    await act(async () => root.render(<MemoryRouter initialEntries={["/studio?panel=settings&settingsTab=project"]}><RoutedSettings /></MemoryRouter>));
    const state = () => JSON.parse(get("route-state")!.textContent!);
    const initialKey = state().key;
    await click("settings-category-nav-picker");
    await click("settings-category-ai");
    expect(state().key).toBe(initialKey);
    await click("settings-category-nav-back");
    expect(state().key).toBe(initialKey);
    await click("settings-category-ai");
    await click("settings-category-ai-audio");
    const audioKey = state().key;
    expect(state()).toEqual({ key: audioKey, category: "ai", itemId: "audio" });
    expect(audioKey).not.toBe(initialKey);
    await click("settings-category-nav-picker");
    await click("settings-category-ai-audio");
    expect(state().key).toBe(audioKey);
    await click("browser-back");
    expect(state()).toEqual({ key: initialKey, category: "overview", itemId: null });
    await click("browser-forward");
    expect(state()).toEqual({ key: audioKey, category: "ai", itemId: "audio" });
    expect(get("settings-category-nav-picker")?.textContent).toContain("Host audio");
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
