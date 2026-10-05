// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDesktopHeader } from "../StudioDesktopHeader";
import { useStudioSearch } from "../useStudioSearch";

function Harness({ docked = false, homeOverview = false, onHomeReturn, orgContext = true }: { orgContext?: boolean; docked?: boolean; homeOverview?: boolean; onHomeReturn?: () => void }) {
  const [drawerHeader, setDrawerHeader] = useState<HTMLDivElement | null>(null);
  const [context, setContext] = useState<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useStudioSearch({
    scopeKey: "viewer:team:space", org: homeOverview ? null : { id: "team", name: "Team" },
    space: homeOverview ? null : { id: "space", name: "Space" }, records: [], returnFocusRef: trigger,
  });
  return <>
    <StudioDesktopHeader orgContext={orgContext} orgName="Workshop" accentColor="violet" homeOverview={homeOverview} onHomeReturn={onHomeReturn} contextRef={setContext} drawerWidth={docked ? 280 : 0} drawerHeaderRef={setDrawerHeader} searchTriggerRef={trigger} searchOpen={search.open} onSearch={search.openSearch}>
      <button data-testid="workspace-tab">Conversation</button>
    </StudioDesktopHeader>
    {context ? createPortal(search.open ? search.renderControl() : homeOverview ? null : <button>Choose space</button>, context) : null}
    {docked && drawerHeader ? createPortal(<button>Filter chats</button>, drawerHeader) : null}
    {search.results}
  </>;
}

describe("Single-row desktop search", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
      return (this.closest("[hidden]") ? [] : [{ width: 100, height: 40 }]) as unknown as DOMRectList;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const input = () => container.querySelector<HTMLInputElement>("input")!;
  const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="studio-desktop-search-trigger"]')!;
  async function key(init: KeyboardEventInit) {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    await act(async () => document.activeElement!.dispatchEvent(event));
    return event;
  }

  it("colors organization context while leaving global Home neutral", async () => {
    await act(async () => root.render(<Harness />));
    expect(container.querySelector("header")?.getAttribute("data-org-accent")).toBe("violet");
    expect(container.textContent).toContain("Workshop");
    await act(async () => root.render(<Harness homeOverview />));
    expect(container.querySelector("header")?.hasAttribute("data-org-accent")).toBe(false);
    expect(container.textContent).not.toContain("Workshop");
    await act(async () => root.render(<Harness orgContext={false} />));
    expect(container.querySelector("header")?.hasAttribute("data-org-accent")).toBe(false);
  });

  it("expands search in place and returns focus to Search without remounting the tabs", async () => {
    await act(async () => root.render(<Harness />));
    const tab = container.querySelector('[data-testid="workspace-tab"]');
    const controls = Array.from(container.querySelectorAll("button"));
    expect(controls.map(button => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["Choose space", "Search", "Conversation"]);
    expect(input()).toBeNull();
    await act(async () => trigger().click());
    expect(document.activeElement).toBe(input());
    expect(container.querySelector("header")?.hasAttribute("data-org-accent")).toBe(false);
    expect(input().getAttribute("aria-label")).toContain("Space");
    expect(tab?.closest("[hidden][inert]")).not.toBeNull();
    await key({ key: "Escape" });
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(container.querySelector('[data-testid="workspace-tab"]')).toBe(tab);
    expect(tab?.closest("[hidden]")).toBeNull();
  });

  it("gives Home one global title and search, retaining keyboard search and focus restoration", async () => {
    await act(async () => root.render(<Harness homeOverview docked />));
    expect(container.querySelector("h1")?.textContent).toBe("Home");
    expect(container.querySelector('[data-testid="workspace-tab"]')).toBeNull();
    expect(container.querySelector('[data-testid="studio-desktop-drawer-header"]')).toBeNull();
    expect(container.textContent).not.toContain("Choose space");
    await act(async () => trigger().focus());
    await key({ key: "k", metaKey: true });
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("aria-label")).not.toContain("Space");
    expect(container.querySelector("h1")).toBeNull();
    await key({ key: "Escape" });
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(document.activeElement).toBe(trigger());
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("offers an independent Home return action only when an origin exists", async () => {
    await act(async () => root.render(<Harness homeOverview />));
    expect(container.querySelector('[data-testid="home-return-navigation"]')).toBeNull();
    const onHomeReturn = vi.fn();
    await act(async () => root.render(<Harness homeOverview onHomeReturn={onHomeReturn} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="home-return-navigation"]')!.click());
    expect(onHomeReturn).toHaveBeenCalledOnce();
    await act(async () => trigger().click());
    expect(container.querySelector('[data-testid="home-return-navigation"]')).toBeNull();
    await key({ key: "Escape" });
    expect(container.querySelector('[data-testid="home-return-navigation"]')).not.toBeNull();
  });

  it("hides docked pane controls while search owns the header and restores them without remounting tabs", async () => {
    await act(async () => root.render(<Harness docked />));
    const pane = container.querySelector('[data-testid="studio-desktop-drawer-header"]')!;
    const tab = container.querySelector('[data-testid="workspace-tab"]');
    expect(pane.textContent).toBe("Filter chats");
    await act(async () => trigger().click());
    expect(pane.hasAttribute("hidden")).toBe(true);
    expect(pane.hasAttribute("inert")).toBe(true);
    await key({ key: "Escape" });
    expect(pane.hasAttribute("hidden")).toBe(false);
    expect(pane.hasAttribute("inert")).toBe(false);
    expect(container.querySelector('[data-testid="workspace-tab"]')).toBe(tab);
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("opens or refocuses search with %o + K", async modifier => {
    await act(async () => root.render(<Harness />));
    expect((await key({ key: "k", ...modifier })).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.focus());
    await key({ key: "k", ...modifier });
    expect(document.activeElement).toBe(input());
  });

  it("leaves ordinary typing, other shortcuts and modal dialogs alone", async () => {
    await act(async () => root.render(<Harness />));
    for (const init of [{ key: "k" }, { key: "k", ctrlKey: true, shiftKey: true }, { key: "k", metaKey: true, altKey: true }]) {
      expect((await key(init)).defaultPrevented).toBe(false);
      expect(input()).toBeNull();
    }
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    container.appendChild(modal);
    expect((await key({ key: "k", metaKey: true })).defaultPrevented).toBe(false);
    expect(input()).toBeNull();
    modal.remove();
  });
});
