// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDesktopHeader } from "../StudioDesktopHeader";
import { useStudioSearch } from "../useStudioSearch";

function Harness() {
  const [context, setContext] = useState<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useStudioSearch({
    scopeKey: "viewer:team:space", org: { id: "team", name: "Team" },
    space: { id: "space", name: "Space" }, records: [], returnFocusRef: trigger,
  });
  return <>
    <StudioDesktopHeader contextRef={setContext} searchTriggerRef={trigger} searchOpen={search.open} onSearch={search.openSearch}>
      <button data-testid="workspace-tab">Conversation</button>
    </StudioDesktopHeader>
    {context ? createPortal(search.open ? search.renderControl() : <button>Choose space</button>, context) : null}
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

  it("expands search in place and returns focus to Search without remounting the tabs", async () => {
    await act(async () => root.render(<Harness />));
    const tab = container.querySelector('[data-testid="workspace-tab"]');
    expect(input()).toBeNull();
    await act(async () => trigger().click());
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("aria-label")).toContain("Space");
    expect(tab?.closest("[hidden][inert]")).not.toBeNull();
    await key({ key: "Escape" });
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(container.querySelector('[data-testid="workspace-tab"]')).toBe(tab);
    expect(tab?.closest("[hidden]")).toBeNull();
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
