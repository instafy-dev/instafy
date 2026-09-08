// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSidebarToggleFocus } from "../useSidebarToggleFocus";

describe("desktop sidebar toggle focus", () => {
  let container: HTMLDivElement;
  let root: Root;
  let wide = true;
  let moveFocusElsewhere = false;

  function Harness() {
    const [collapsed, setCollapsed] = useState(false);
    const prepareFocus = useSidebarToggleFocus(wide, collapsed);
    const toggle = () => {
      prepareFocus();
      setCollapsed((value) => !value);
      if (moveFocusElsewhere) container.querySelector<HTMLButtonElement>('[data-testid="other"]')?.focus();
    };
    return <>
      {collapsed ? <button data-testid="topbar-sidebar-toggle" onClick={toggle}>Expand</button> :
        <nav data-testid="sidebar-context-navigation"><button data-testid="sidebar-drawer-toggle" onClick={toggle}>Collapse</button></nav>}
      <button data-testid="other" onClick={toggle}>Other action</button>
    </>;
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    wide = true;
    moveFocusElsewhere = false;
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

  it("keeps focus on the replacement control across collapse and reopen", async () => {
    const collapse = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-drawer-toggle"]')!;
    collapse.focus();
    await act(async () => collapse.click());
    const expand = container.querySelector<HTMLButtonElement>('[data-testid="topbar-sidebar-toggle"]')!;
    expect(document.activeElement).toBe(expand);
    await act(async () => expand.click());
    expect(document.activeElement).toBe(container.querySelector('[data-testid="sidebar-drawer-toggle"]'));
  });

  it("does not take focus from an unrelated action", async () => {
    const other = container.querySelector<HTMLButtonElement>('[data-testid="other"]')!;
    other.focus();
    await act(async () => other.click());
    expect(document.activeElement).toBe(other);
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
    const collapse = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-drawer-toggle"]')!;
    collapse.focus();
    await act(async () => collapse.click());
    expect(document.activeElement).toBe(document.body);
  });
});
