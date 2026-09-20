// @vitest-environment jsdom
import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioOrganizationRail } from "../StudioOrganizationRail";

const organizations = [
  { key: "one", name: "One", label: "One", slug: null, count: 2 },
  { key: "empty", name: "Empty", label: "Empty · example", slug: "example", count: 0 },
  { key: "three", name: "Three", label: "Three", slug: null, count: 1, avatarUrl: "https://example.test/three.png" },
];

describe("StudioOrganizationRail", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onHome = vi.fn();
  const onSelectOrganization = vi.fn();
  const onOpenOrganizationOverview = vi.fn();
  const onOpenOrganizationSettings = vi.fn();
  const onCreateOrganization = vi.fn();
  const onBrowseOrganizations = vi.fn();
  const render = async (props: Partial<ComponentProps<typeof StudioOrganizationRail>> = {}) => {
    await act(async () => root.render(<StudioOrganizationRail organizations={organizations}
      selectedOrgKey="one" homeActive={false} titleBarFree={false}
      onHome={onHome} onSelectOrganization={onSelectOrganization}
      onOpenOrganizationOverview={onOpenOrganizationOverview} onOpenOrganizationSettings={onOpenOrganizationSettings}
      onCreateOrganization={onCreateOrganization} onBrowseOrganizations={onBrowseOrganizations}
      browseButtonRef={createRef<HTMLButtonElement>()} account={<button data-testid="account">Account</button>}
      {...props} />));
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    // JSDOM lacks the CSS.escape API React Aria uses for menu keyboard focus.
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps Home and footer actions outside the scrolling team list, including empty teams", async () => {
    await render();
    const list = container.querySelector('[data-testid="sidebar-team-rail-list"]')!;
    expect(list.querySelectorAll("button")).toHaveLength(3);
    expect(list.querySelector('[data-testid="sidebar-home-button"]')).toBeNull();
    expect(list.querySelector('[data-testid="sidebar-rail-actions"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-team-empty"]')?.getAttribute("aria-label")).toBe("Empty · example");
    expect(container.querySelector('[data-testid="sidebar-team-three"] img')?.getAttribute("src")).toBe("https://example.test/three.png");
    const footer = container.querySelector('[data-testid="sidebar-rail-actions"]')!;
    expect(Array.from(footer.querySelectorAll("button")).map((item) => item.dataset.testid))
      .toEqual(["sidebar-org-new", "sidebar-browse-teams", "account"]);
  });

  it("selects exact teams and keeps global Home selection distinct from remembered team", async () => {
    await render({ homeActive: true, homeAttentionCount: 3, orgAttentionCounts: { empty: 2 } });
    const home = container.querySelector('[data-testid="sidebar-home-button"]');
    expect(home?.getAttribute("aria-current")).toBe("page");
    expect(home?.getAttribute("aria-label")).toBe("Home — all teams");
    expect(home?.getAttribute("title")).toBe("Home — all teams");
    expect(document.getElementById(home!.getAttribute("aria-describedby")!)?.textContent).toBe("3 unread updates across teams");
    expect(container.querySelector('[data-testid="sidebar-home-badge"]')?.textContent).toBe("3");
    expect(container.querySelector('[data-testid="sidebar-home-badge"]')?.getAttribute("title")).toBe("3 unread updates across teams");
    expect(container.querySelector('[data-testid="sidebar-team-one"]')?.hasAttribute("aria-current")).toBe(false);
    expect(container.querySelector('[data-testid="sidebar-team-empty"]')?.getAttribute("aria-label")).toContain("2 unread updates");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="sidebar-home-button"]')?.click();
      container.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-empty"]')?.click();
      container.querySelector<HTMLButtonElement>('[data-testid="sidebar-org-new"]')?.click();
      container.querySelector<HTMLButtonElement>('[data-testid="sidebar-browse-teams"]')?.click();
    });
    expect(onHome).toHaveBeenCalledOnce();
    expect(onSelectOrganization).toHaveBeenCalledWith("empty");
    expect(onCreateOrganization).toHaveBeenCalledOnce();
    expect(onBrowseOrganizations).toHaveBeenCalledOnce();
  });

  it("announces a single unread update for Home and teams without implying it is a chat", async () => {
    await render({ homeAttentionCount: 1, orgAttentionCounts: { one: 1 } });
    const home = container.querySelector('[data-testid="sidebar-home-button"]')!;
    expect(document.getElementById(home.getAttribute("aria-describedby")!)?.textContent).toBe("1 unread update across teams");
    expect(container.querySelector('[data-testid="sidebar-team-one"]')?.getAttribute("aria-label")).toBe("One, 1 unread update");
    expect(container.querySelector('[data-testid="sidebar-team-attention-one"]')?.getAttribute("title")).toBe("1 unread update");
    await render();
    expect(container.querySelector('[data-testid="sidebar-home-button"]')?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("preserves list scroll during unrelated renders and reveals selection by scrolling only the list", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this.dataset.testid === "sidebar-team-rail-list" ? 100
        : this.dataset.testid === "sidebar-team-three" ? 340 : 110;
      const height = this.dataset.testid === "sidebar-team-rail-list" ? 200 : 44;
      return { top, bottom: top + height, height, left: 0, right: 64, width: 64, x: 0, y: top, toJSON: () => ({}) };
    });
    await render();
    const list = container.querySelector<HTMLDivElement>('[data-testid="sidebar-team-rail-list"]')!;
    list.scrollTop = 30;
    await render({ homeActive: true });
    expect(container.querySelector('[data-testid="sidebar-team-rail-list"]')).toBe(list);
    expect(list.scrollTop).toBe(30);
    await render({ selectedOrgKey: "three" });
    expect(list.scrollTop).toBe(118);
    expect(window.scrollY).toBe(0);
    expect(container.querySelector('[data-testid="sidebar-team-three"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("keeps browsing and account access when team creation is unavailable", async () => {
    await render({ onCreateOrganization: undefined, organizations: [] });
    expect(container.querySelector('[data-testid="sidebar-org-new"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-browse-teams"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="account"]')).not.toBeNull();
  });

  it("keeps desktop window-button clearance on the permanent rail", async () => {
    await render({ titleBarFree: true });
    const nav = container.querySelector<HTMLElement>('[data-testid="sidebar-organization-rail"]')!;
    expect(nav.style.paddingTop).toBe("48px");
    expect(nav.querySelector<HTMLElement>("[data-rail-surface]")?.style.top).toBe("48px");
    await render({ titleBarFree: false });
    expect(nav.querySelector("[data-rail-surface]")).toBeNull();
    expect(nav.className).toContain("pt-[var(--instafy-safe-area-inset-top)]");
  });
  it("carries org color through selection without changing unread counts or logo", async () => {
    await render({ organizations: organizations.map(org => ({ ...org, accentColor: "violet" })), selectedOrgKey: "three", orgAttentionCounts: { three: 2 } });
    const selected = container.querySelector('[data-testid="sidebar-team-three"]')!;
    expect(selected.getAttribute("data-org-accent")).toBe("violet");
    expect(selected.getAttribute("aria-current")).toBe("page");
    expect(selected.querySelector('img')?.getAttribute("src")).toBe("https://example.test/three.png");
    expect(container.querySelector('[data-testid="sidebar-team-attention-three"]')?.textContent).toBe("2");
    await render({ homeActive: true });
    expect(container.querySelector('[data-testid="sidebar-home-button"]')?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('[data-testid="sidebar-team-one"]')?.hasAttribute("aria-current")).toBe(false);
  });

  const openContextMenu = async (key: string) => {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="sidebar-team-${key}"]`)!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    await act(async () => { button.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    return button;
  };
  const contextAction = async (action: string) => {
    await act(async () => document.querySelector<HTMLElement>(`[data-testid="sidebar-org-context-${action}"]`)!.click());
  };

  it("opens settings and members for the right-clicked inactive or empty team without selecting it first", async () => {
    await render();
    await openContextMenu("empty");
    expect(onSelectOrganization).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Team actions: Empty");
    await contextAction("settings");
    expect(onOpenOrganizationSettings).toHaveBeenLastCalledWith("empty", "profile");
    expect(document.querySelector('[data-testid="sidebar-org-context-menu"]')).toBeNull();
    await openContextMenu("three"); await contextAction("members");
    expect(onOpenOrganizationSettings).toHaveBeenLastCalledWith("three", "members");
    await openContextMenu("empty"); await contextAction("overview");
    expect(onOpenOrganizationOverview).toHaveBeenCalledExactlyOnceWith("empty");
    expect(onSelectOrganization).not.toHaveBeenCalled();
  });

  it("supports Shift+F10 and the menu key, and Escape restores icon focus without navigation", async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-team-empty"]')!;
    for (const init of [{ key: "F10", shiftKey: true }, { key: "ContextMenu" }]) {
      await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true })); });
      expect(document.querySelector('[data-testid="sidebar-org-context-menu"]')).not.toBeNull();
      await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
      expect(document.querySelector('[data-testid="sidebar-org-context-menu"]')).toBeNull();
      await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      expect(document.activeElement).toBe(trigger);
    }
    expect(onSelectOrganization).not.toHaveBeenCalled();
    expect(onOpenOrganizationOverview).not.toHaveBeenCalled();
    expect(onOpenOrganizationSettings).not.toHaveBeenCalled();
  });

  it("dismisses stale menus on team changes and omits unavailable settings actions", async () => {
    await render(); await openContextMenu("empty");
    await render({ organizations: [organizations[0]] });
    expect(document.querySelector('[data-testid="sidebar-org-context-menu"]')).toBeNull();
    await render({ onOpenOrganizationSettings: undefined });
    expect(document.querySelector('[data-testid="sidebar-org-context-menu"]')).toBeNull();
    await openContextMenu("one");
    expect(document.querySelector('[data-testid="sidebar-org-context-settings"]')).toBeNull();
    expect(document.querySelector('[data-testid="sidebar-org-context-members"]')).toBeNull();
    await render({ selectedOrgKey: "three" });
    expect(document.querySelector('[data-testid="sidebar-org-context-menu"]')).toBeNull();
  });

});
