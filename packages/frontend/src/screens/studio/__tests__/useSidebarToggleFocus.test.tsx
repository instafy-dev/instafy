// @vitest-environment jsdom

import { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSidebarToggleFocus } from "../useSidebarToggleFocus";

describe("desktop sidebar toggle focus", () => {
  let container: HTMLDivElement;
  let root: Root;
  let wide = true;
  let moveFocusElsewhere = false;
  let popoverTestId = "sidebar-recent-chats-popover";

  function Harness() {
    const [collapsed, setCollapsed] = useState(false);
    const prepareFocus = useSidebarToggleFocus(wide, collapsed);
    const toggle = () => {
      prepareFocus();
      setCollapsed((value) => !value);
      if (moveFocusElsewhere) container.querySelector<HTMLButtonElement>('[data-testid="other"]')?.focus();
    };
    return <>
      <nav data-testid="sidebar-context-navigation">
        <button data-testid="sidebar-drawer-toggle" onClick={toggle}>{collapsed ? "Expand" : "Collapse"}</button>
        {!collapsed ? <button data-testid="detail" onClick={toggle}>Expanded detail</button> : null}
      </nav>
      {collapsed ? createPortal(<div data-testid={popoverTestId}>
        <button data-testid="popover-detail" onClick={toggle}>Recent chat</button>
      </div>, document.body) : null}
      <button data-testid="other" onClick={toggle}>Other action</button>
    </>;
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    wide = true;
    moveFocusElsewhere = false;
    popoverTestId = "sidebar-recent-chats-popover";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps focus on the same rail control across collapse and expand", async () => {
    const collapse = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-drawer-toggle"]')!;
    collapse.focus();
    await act(async () => collapse.click());
    expect(document.activeElement).toBe(collapse);
    expect(collapse.textContent).toBe("Expand");
    await act(async () => collapse.click());
    expect(document.activeElement).toBe(collapse);
    expect(collapse.textContent).toBe("Collapse");
  });

  it("restores focus to the rail toggle when a focused detail disappears", async () => {
    const detail = container.querySelector<HTMLButtonElement>('[data-testid="detail"]')!;
    detail.focus();
    await act(async () => detail.click());
    expect(document.activeElement).toBe(container.querySelector('[data-testid="sidebar-drawer-toggle"]'));
  });

  it("does not take focus from an unrelated action", async () => {
    const other = container.querySelector<HTMLButtonElement>('[data-testid="other"]')!;
    other.focus();
    await act(async () => other.click());
    expect(document.activeElement).toBe(other);
  });

  it.each(["sidebar-recent-chats-popover", "sidebar-recent-spaces-popover", "sidebar-more-menu", "sidebar-team-menu"])("restores focus from %s removed when expanding", async (testId) => {
    popoverTestId = testId;
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="sidebar-drawer-toggle"]')!.click());
    const detail = document.querySelector<HTMLButtonElement>('[data-testid="popover-detail"]')!;
    detail.focus();
    await act(async () => detail.click());
    expect(document.activeElement).toBe(container.querySelector('[data-testid="sidebar-drawer-toggle"]'));
  });

  it("does not override focus moved elsewhere during the toggle", async () => {
    moveFocusElsewhere = true;
    const collapse = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-drawer-toggle"]')!;
    collapse.focus();
    await act(async () => collapse.click());
    expect(document.activeElement).toBe(container.querySelector('[data-testid="other"]'));
  });

  it("leaves mobile focus restoration to its drawer", async () => {
    wide = false;
    await act(async () => root.render(<Harness />));
    const detail = container.querySelector<HTMLButtonElement>('[data-testid="detail"]')!;
    detail.focus();
    await act(async () => detail.click());
    expect(document.activeElement).toBe(document.body);
  });
});
