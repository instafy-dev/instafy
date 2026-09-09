// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioRecentSpaces, type StudioRecentSpacesProps } from "../StudioRecentSpaces";

function Harness(props: Partial<StudioRecentSpacesProps>) {
  return (
    <StudioRecentSpaces
      spaces={[{ id: "current", name: "Website" }, { id: "recent", name: "Documentation" }]}
      recency={{ recent: 100 }}
      activeProjectId="current"
      onSelectSpace={vi.fn()}
      onBrowseAll={vi.fn()}
      collapsed={false}
      expanded
      onExpandedChange={vi.fn()}
      rowClassName=""
      iconClassName=""
      {...props}
    />
  );
}

describe("StudioRecentSpaces", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(props: Partial<StudioRecentSpacesProps> = {}) {
    await act(async () => root.render(<Harness {...props} />));
  }

  async function click(testId: string) {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(button).not.toBeNull();
    await act(async () => button?.click());
  }

  function rowIds() {
    return [...document.querySelectorAll('button[data-testid^="sidebar-recent-space-"]')]
      .map((row) => row.getAttribute("data-testid"));
  }

  it("selects the current space and five most recent visits, then lays them out A–Z without mutating candidates", async () => {
    const spaces = Object.freeze([
      { id: "oldest", name: "An old space" },
      { id: "newest", name: "Website" },
      { id: "current", name: "Mobile" },
      { id: "design", name: "Design" },
      { id: "docs", name: "Docs" },
      { id: "core", name: "Core product" },
      { id: "autofix", name: "Autofix" },
      { id: "unvisited", name: "Brand new" },
    ]);
    await render({ spaces, recency: { newest: 600, design: 500, docs: 400, core: 300, autofix: 200, oldest: 100 } });
    expect(rowIds()).toEqual([
      "sidebar-recent-space-autofix", "sidebar-recent-space-core", "sidebar-recent-space-design",
      "sidebar-recent-space-docs", "sidebar-recent-space-current", "sidebar-recent-space-newest",
    ]);
    expect(container.querySelector('[data-testid="sidebar-browse-all-spaces"]')).not.toBeNull();
    expect(spaces.map((space) => space.id)).toEqual(["oldest", "newest", "current", "design", "docs", "core", "autofix", "unvisited"]);
  });

  it("keeps shortcut order and DOM nodes stable when an existing member becomes current and more recent", async () => {
    const spaces = [{ id: "website", name: "Website" }, { id: "docs", name: "Documentation" }, { id: "autofix", name: "Autofix" }];
    await render({ spaces, recency: { website: 300, docs: 200, autofix: 100 }, activeProjectId: "website" });
    const before = [...container.querySelectorAll('ul[aria-label="Recent spaces"] button')];
    await render({ spaces, recency: { website: 300, docs: 400, autofix: 100 }, activeProjectId: "docs" });
    expect(rowIds()).toEqual(["sidebar-recent-space-autofix", "sidebar-recent-space-docs", "sidebar-recent-space-website"]);
    const after = [...container.querySelectorAll('ul[aria-label="Recent spaces"] button')];
    after.forEach((button, index) => expect(button).toBe(before[index]));
    expect(after[1].getAttribute("aria-current")).toBe("page");
    expect(after[2].getAttribute("aria-current")).toBeNull();
  });

  it("uses names and IDs as stable tie breakers for equally recent spaces", async () => {
    await render({
      spaces: [{ id: "z", name: "Beta" }, { id: "b", name: "Alpha" }, { id: "a", name: "Alpha" }],
      recency: { a: 100, b: 100, z: 100 },
      activeProjectId: null,
    });
    expect(rowIds()).toEqual(["sidebar-recent-space-a", "sidebar-recent-space-b", "sidebar-recent-space-z"]);
  });

  it("requires positive finite visits for non-current rows and never invents unavailable candidates", async () => {
    await render({
      spaces: ["unvisited", "zero", "negative", "nan", "infinite", "visited"].map((id) => ({ id, name: id })),
      recency: { zero: 0, negative: -100, nan: Number.NaN, infinite: Infinity, visited: 100, unavailable: 1000 },
      activeProjectId: "unavailable",
    });
    expect(container.querySelector('[data-testid="sidebar-space-button"]')?.getAttribute("aria-label")).toBe("Choose space");
    expect(rowIds()).toEqual(["sidebar-recent-space-visited"]);
    expect(container.querySelector('[aria-current="page"]')).toBeNull();
  });

  it("offers Browse all when no accessible space has been visited", async () => {
    const onBrowseAll = vi.fn();
    await render({ spaces: [{ id: "unvisited", name: "Unvisited" }], recency: {}, activeProjectId: null, onBrowseAll });
    expect(container.textContent).toContain("Choose space");
    expect(rowIds()).toEqual([]);
    expect(container.textContent).toContain("No recent spaces in this team.");
    await click("sidebar-browse-all-spaces");
    expect(onBrowseAll).toHaveBeenCalledTimes(1);
  });

  it("keeps the current identity above an inline grid without adding a Spaces heading", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    await render({ triggerRef });
    const trigger = container.querySelector('[data-testid="sidebar-space-button"]');
    expect(triggerRef.current).toBe(trigger);
    expect(trigger?.getAttribute("aria-label")).toBe("Choose space: Website");
    expect(trigger?.getAttribute("title")).toBe("Choose space: Website");
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(trigger?.querySelector('[data-testid="space-identity"]')?.textContent).toBe("W");
    expect(trigger?.textContent).toBe("WWebsite");
    const list = container.querySelector('[data-testid="sidebar-recent-spaces-list"]');
    expect(list).not.toBeNull();
    expect(trigger?.getAttribute("aria-controls")).toBe(list?.id);
    expect(container.querySelector('section[aria-label="Spaces"]')).toBeNull();
    expect(container.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("toggles the inline grid without navigating or opening a popover", async () => {
    const onExpandedChange = vi.fn();
    const onSelectSpace = vi.fn();
    const onBrowseAll = vi.fn();
    await render({ onExpandedChange, onSelectSpace, onBrowseAll });
    await click("sidebar-space-button");
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
    await render({ expanded: false, onExpandedChange, onSelectSpace, onBrowseAll });
    const trigger = container.querySelector('[data-testid="sidebar-space-button"]');
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.getAttribute("aria-controls")).toBeNull();
    expect(rowIds()).toEqual([]);
    await click("sidebar-space-button");
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);
    expect(onSelectSpace).not.toHaveBeenCalled();
    expect(onBrowseAll).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens the same grid beside the compact current-space icon without toggling inline state", async () => {
    const onExpandedChange = vi.fn();
    const onSelectSpace = vi.fn();
    const onBrowseAll = vi.fn();
    await render({ collapsed: true, onExpandedChange, onSelectSpace, onBrowseAll });
    const trigger = container.querySelector('[data-testid="sidebar-space-button"]');
    expect(trigger?.textContent).toBe("W");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(rowIds()).toEqual([]);
    await click("sidebar-space-button");
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Recent spaces");
    expect(rowIds()).toEqual(["sidebar-recent-space-recent", "sidebar-recent-space-current"]);
    expect(container.querySelector('[data-testid="sidebar-recent-spaces-list"]')).toBeNull();
    expect(onExpandedChange).not.toHaveBeenCalled();
    expect(onSelectSpace).not.toHaveBeenCalled();
    expect(onBrowseAll).not.toHaveBeenCalled();
  });

  it("preserves full names, custom identity and an accessible Current state", async () => {
    const name = "Averylongunbreakablewebsitespacenamethatremainsfullyaccessible";
    await render({ spaces: [{ id: "current", name, icon: "🚀", color: "blue" }] });
    const row = document.querySelector('[data-testid="sidebar-recent-space-current"]');
    expect(row?.getAttribute("aria-current")).toBe("page");
    expect(row?.getAttribute("aria-label")).toBe(`${name}, Current`);
    expect(row?.getAttribute("title")).toBe(`${name} · Current`);
    expect(row?.querySelector('[data-testid="space-identity"]')?.textContent).toBe("🚀");
    expect(row?.textContent).toContain(name);
  });

  it("normalizes empty or whitespace names in the trigger, shortcuts and alphabetical order", async () => {
    await render({ spaces: [{ id: "current", name: " " }, { id: "recent", name: " Website " }] });
    expect(container.querySelector('[data-testid="sidebar-space-button"]')?.getAttribute("aria-label")).toBe("Choose space: Untitled space");
    expect(rowIds()).toEqual(["sidebar-recent-space-current", "sidebar-recent-space-recent"]);
    expect(container.querySelector('[data-testid="sidebar-recent-space-current"]')?.getAttribute("title")).toBe("Untitled space · Current");
    expect(container.querySelector('[data-testid="sidebar-recent-space-recent"]')?.textContent).toBe("WWebsite");
  });

  it("shows unread-chat badges on the current trigger and space icons with exact accessible counts", async () => {
    await render({ attentionCounts: { current: 12, recent: 1 } });
    const current = container.querySelector('[data-testid="sidebar-recent-space-current"]');
    expect(current?.getAttribute("aria-label")).toBe("Website, Current, 12 chats with unread replies");
    expect(current?.querySelector('[data-testid="sidebar-recent-space-attention-current"]')?.textContent).toBe("9+");
    const recent = container.querySelector('[data-testid="sidebar-recent-space-recent"]');
    expect(recent?.getAttribute("aria-label")).toBe("Documentation, 1 chat with unread replies");
    expect(recent?.querySelector('[data-testid="sidebar-recent-space-attention-recent"]')?.textContent).toBe("1");
    expect(container.querySelector('[data-testid="sidebar-space-button"]')?.getAttribute("aria-label")).toBe("Choose space: Website, 12 chats with unread replies");
    const badge = container.querySelector('[data-testid="sidebar-current-space-attention"]');
    expect(badge?.textContent).toBe("9+");
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    expect(badge?.getAttribute("title")).toBe("12 chats with unread replies");
  });

  it.each([0, -1, Number.NaN, Infinity])("hides invalid or zero unread counts (%s) without changing selection", async (count) => {
    await render({ attentionCounts: { current: count, recent: count } });
    expect(container.querySelector('[data-testid="sidebar-current-space-attention"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-recent-space-attention-recent"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-recent-space-current"]')?.getAttribute("aria-label")).toBe("Website, Current");
    expect(container.querySelector('[data-testid="sidebar-recent-space-current"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("keeps inline shortcuts visible after selecting a space or browsing all", async () => {
    const onSelectSpace = vi.fn();
    const onBrowseAll = vi.fn();
    const onExpandedChange = vi.fn();
    await render({ onSelectSpace, onBrowseAll, onExpandedChange });
    await click("sidebar-recent-space-recent");
    expect(onSelectSpace).toHaveBeenCalledWith("recent");
    expect(container.querySelector('[data-testid="sidebar-recent-spaces-list"]')).not.toBeNull();
    await click("sidebar-browse-all-spaces");
    expect(onBrowseAll).toHaveBeenCalledTimes(1);
    expect(onExpandedChange).not.toHaveBeenCalled();
  });

  it("dismisses the compact popover after selecting a space or browsing all", async () => {
    const onSelectSpace = vi.fn();
    const onBrowseAll = vi.fn();
    await render({ collapsed: true, onSelectSpace, onBrowseAll });
    await click("sidebar-space-button");
    await click("sidebar-recent-space-recent");
    expect(onSelectSpace).toHaveBeenCalledWith("recent");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
    await click("sidebar-space-button");
    await click("sidebar-browse-all-spaces");
    expect(onBrowseAll).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
  });

  it("dismisses the compact popover on Escape and width changes without reopening it", async () => {
    await render({ collapsed: true });
    await click("sidebar-space-button");
    const dialog = document.querySelector('[role="dialog"]');
    await act(async () => {
      dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
    await click("sidebar-space-button");
    await render({ collapsed: false });
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-recent-spaces-list"]')).not.toBeNull();
    await render({ collapsed: true });
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-space-button"]')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("dismisses an open compact popover when another control changes the current space", async () => {
    await render({ collapsed: true });
    await click("sidebar-space-button");
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).not.toBeNull();
    await render({ collapsed: true, activeProjectId: "recent" });
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-space-button"]')?.getAttribute("aria-label")).toBe("Choose space: Documentation");
  });
});
