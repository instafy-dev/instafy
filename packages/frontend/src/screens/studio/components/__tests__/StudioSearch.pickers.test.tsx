// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioRecentSpaces } from "../StudioRecentSpaces";
import { StudioSearchContext } from "../StudioSearchContext";
import { StudioSidebarTeamMenu } from "../StudioSidebarTeamMenu";
import { useStudioSearch } from "../useStudioSearch";

describe("Studio search with the real navigation pickers", () => {
  let container: HTMLDivElement;
  let root: Root;
  const selectSpace = vi.fn();

  function Harness() {
    const search = useStudioSearch({
      scopeKey: "account:team:space", org: { id: "team", name: "Workshop" },
      space: { id: "space", name: "Autofix" }, records: [], persistentControl: true,
    });
    return <>
      {search.renderControl(false, <StudioSearchContext scope={search.scope} onBroaden={search.changeScope} context={{
        teamName: "Workshop", onBrowseTeams: () => search.closeSearch(false),
        team: <StudioSidebarTeamMenu teamName="Workshop" compact={false} active={false} rowClassName="" iconClassName="" onOpenOverview={() => search.closeSearch(false)} />,
        space: <StudioRecentSpaces spaces={[{ id: "space", name: "Autofix" }, { id: "other", name: "Core" }]}
          recency={{ other: 10 }} activeProjectId="space" presentation="path" collapsed={false} expanded={false}
          onExpandedChange={() => {}} rowClassName="" iconClassName=""
          onSelectSpace={id => { search.closeSearch(false); selectSpace(id); }} onBrowseAll={() => search.closeSearch(false)} />,
      }} />)}
      {search.results}
    </>;
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    selectSpace.mockClear();
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const input = () => container.querySelector<HTMLInputElement>('[data-testid="studio-search-input"]')!;
  const results = () => container.querySelector('[data-testid="studio-search-results"]');
  async function click(testId: string) {
    const target = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(target).not.toBeNull();
    await act(async () => target!.click());
  }
  async function escape() {
    // JSDOM has no popover geometry, so place focus where React Aria places it
    // in the browser before dispatching the key to that active overlay.
    const target = document.querySelector<HTMLElement>('[role="menuitem"], [data-testid="sidebar-recent-space-space"]')!;
    await act(async () => target.focus());
    await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  }

  it("opens the team menu without starting search and preserves the field node", async () => {
    const originalInput = input();
    await click("sidebar-team-menu-trigger");
    expect(document.querySelector('[data-testid="sidebar-team-menu"]')).not.toBeNull();
    expect(results()).toBeNull();
    await escape();
    expect(document.querySelector('[data-testid="sidebar-team-menu"]')).toBeNull();
    expect(input()).toBe(originalInput);
    expect(results()).toBeNull();
  });

  it.each(["team", "space"] as const)("Escape dismisses the %s picker while keeping the active search open", async kind => {
    const originalInput = input();
    await act(async () => originalInput.focus());
    expect(results()).not.toBeNull();
    const triggerId = kind === "team" ? "sidebar-team-menu-trigger" : "sidebar-space-button";
    const popoverId = kind === "team" ? "sidebar-team-menu" : "sidebar-recent-spaces-popover";
    await click(triggerId);
    expect(document.querySelector(`[data-testid="${popoverId}"]`)).not.toBeNull();
    await escape();
    expect(document.querySelector(`[data-testid="${popoverId}"]`)).toBeNull();
    expect(results()).not.toBeNull();
    expect(input()).toBe(originalInput);
  });

  it("closes search when the real space picker activates a destination", async () => {
    await act(async () => input().focus());
    await click("sidebar-space-button");
    await click("sidebar-recent-space-other");
    expect(selectSpace).toHaveBeenCalledExactlyOnceWith("other");
    expect(results()).toBeNull();
    expect(document.querySelector('[data-testid="sidebar-recent-spaces-popover"]')).toBeNull();
  });
});
