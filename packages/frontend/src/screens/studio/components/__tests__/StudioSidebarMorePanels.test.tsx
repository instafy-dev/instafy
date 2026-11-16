// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioNavItem } from "../../types";
import { StudioSidebarMorePanels } from "../StudioSidebarMorePanels";

const DIVIDER_CLASSES = ["border-t", "border-slate-200/70", "pt-1", "dark:border-[color:var(--color-studio-dark-divider)]"];
const page = (id: StudioNavItem["id"], label: string): StudioNavItem => ({ id, label, icon: () => <svg />, accent: "" });
const setupPages = [page("extensions", "Extensions"), page("secrets", "Secrets"), page("skills", "Skills")];

describe("StudioSidebarMorePanels", () => {
  let root: Root;
  let container: HTMLDivElement;

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

  const render = (props: Partial<ComponentProps<typeof StudioSidebarMorePanels>>) => act(async () => root.render(
    <ul>
      <li>Assistant</li>
      <StudioSidebarMorePanels
        resolvedMoreItems={setupPages}
        showInlineMoreItems
        inlineMoreItems={setupPages}
        collapsedMoreItems={[]}
        activePanel="chat"
        showLabels
        isLargeScreen
        sidebarRowLayoutClass=""
        moreMenuOpen={false}
        onMoreMenuOpenChange={vi.fn()}
        onMobileMoreToggle={vi.fn()}
        onMoreMenuAction={vi.fn()}
        getSidebarRowToneClass={() => ""}
        getSidebarNavIconClass={() => ""}
        isMorePanelActive={false}
        moreSwitcherOpen={false}
        moreIndicator={null}
        selectedMoreKeys={[]}
        {...props}
      />
    </ul>,
  ));
  // The row after the daily tools: the group that holds the setup pages.
  const group = () => container.querySelector<HTMLLIElement>(":scope > ul > li:nth-child(2)");

  it.each([true, false])("sets the setup pages apart with the quiet divider, labels shown=%s", async showLabels => {
    await render({ showLabels });
    expect([...group()!.classList]).toEqual(expect.arrayContaining(DIVIDER_CLASSES));
    const list = group()!.querySelector('ul[aria-label="More panels"]')!;
    expect([...list.querySelectorAll("[data-testid^='sidebar-more-item-']")].map(item => item.getAttribute("data-testid")))
      .toEqual(["sidebar-more-item-extensions", "sidebar-more-item-secrets", "sidebar-more-item-skills"]);
    expect(group()!.querySelector("h1, h2, h3, h4, [role='heading']")).toBeNull();
  });

  it.each([true, false])("keeps the divider above More when every setup page overflows, large screen=%s", async isLargeScreen => {
    await render({ isLargeScreen, showInlineMoreItems: false, inlineMoreItems: [], collapsedMoreItems: setupPages });
    expect([...group()!.classList]).toEqual(expect.arrayContaining(DIVIDER_CLASSES));
    expect(group()!.querySelector('[data-testid="sidebar-nav-more"]')?.getAttribute("aria-label")).toBe("More");
  });

  it("draws no divider when there are no setup pages", async () => {
    await render({ resolvedMoreItems: [], inlineMoreItems: [], showInlineMoreItems: false });
    expect(group()).toBeNull();
  });
});
