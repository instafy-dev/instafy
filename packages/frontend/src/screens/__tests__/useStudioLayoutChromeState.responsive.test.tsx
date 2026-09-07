// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStudioLayoutChromeState } from "../useStudioLayoutChromeState";

describe("workspace picker responsive navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let chrome: ReturnType<typeof useStudioLayoutChromeState>;

  function Harness({ wide }: { wide: boolean }) {
    chrome = useStudioLayoutChromeState({ isLargeScreen: wide });
    return null;
  }

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

  it("keeps the picker open when moving between a desktop panel and mobile navigation", async () => {
    await act(async () => root.render(<Harness wide />));
    await act(async () => chrome.setLeftDrawer("workspaces"));
    expect(chrome.mobileSidebarOpen).toBe(false);

    await act(async () => root.render(<Harness wide={false} />));
    expect(chrome.leftDrawer).toBe("workspaces");
    expect(chrome.mobileSidebarOpen).toBe(true);

    await act(async () => root.render(<Harness wide />));
    expect(chrome.leftDrawer).toBe("workspaces");
    expect(chrome.mobileSidebarOpen).toBe(false);
  });

  it("returns to mobile navigation on Back and replaces it when chat history opens", async () => {
    await act(async () => root.render(<Harness wide={false} />));
    await act(async () => chrome.setLeftDrawer("workspaces"));
    expect(chrome.mobileSidebarOpen).toBe(true);

    await act(async () => chrome.setLeftDrawer(null));
    expect(chrome.mobileSidebarOpen).toBe(true);

    await act(async () => chrome.setLeftDrawer("history"));
    expect(chrome.leftDrawer).toBe("history");
    expect(chrome.mobileSidebarOpen).toBe(false);
  });

  it("respects an Escape handled by nested content, then dismisses an unhandled Escape", async () => {
    await act(async () => root.render(<Harness wide={false} />));
    await act(async () => chrome.setLeftDrawer("workspaces"));
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    await act(async () => { window.dispatchEvent(handled); });
    expect(chrome.leftDrawer).toBe("workspaces");
    expect(chrome.mobileSidebarOpen).toBe(true);

    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(chrome.leftDrawer).toBeNull();
    expect(chrome.mobileSidebarOpen).toBe(false);
  });
});
