// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationSurfaceTabs } from "../ConversationSurfaceLayout";

describe("ConversationSurfaceTabs", () => {
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

  it("exposes the selected surface as an accessible tab", async () => {
    const onTabChange = vi.fn();
    await act(async () => {
      root.render(
        <ConversationSurfaceTabs
          activeId="browser"
          resourceId="browser" split={false} wide={false} ratio={.55} onSplitChange={() => {}}
          resources={[{ id: "browser", label: "Browser", panelId: "browser-panel" }]}
          chatPanelId="chat-panel"
          onSelect={onTabChange}
        />,
      );
    });

    const chatTab = container.querySelector<HTMLButtonElement>('[data-testid="conversation-subtab-chat"]');
    const browserTab = container.querySelector<HTMLButtonElement>('[data-testid="conversation-subtab-browser"]');
    expect(chatTab?.getAttribute("aria-selected")).toBe("false");
    expect(browserTab?.getAttribute("aria-selected")).toBe("true");
    expect(browserTab?.getAttribute("aria-controls")).toBe("browser-panel");
    expect(browserTab?.className).toContain("max-[540px]:h-10");
    expect(browserTab?.className).toContain("pointer-coarse:min-h-11");

    await act(async () => chatTab?.click());
    expect(onTabChange).toHaveBeenCalledWith("chat");
  });

  it("supports arrow-key navigation between surfaces", async () => {
    const onTabChange = vi.fn();
    await act(async () => {
      root.render(
        <ConversationSurfaceTabs
          activeId="chat"
          resourceId="browser" split={false} wide={false} ratio={.55} onSplitChange={() => {}}
          resources={[{ id: "browser", label: "Browser", panelId: "browser-panel" }]}
          chatPanelId="chat-panel"
          onSelect={onTabChange}
        />,
      );
    });

    const chatTab = container.querySelector<HTMLButtonElement>('[data-testid="conversation-subtab-chat"]');
    await act(async () => {
      chatTab?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });
    expect(onTabChange).toHaveBeenCalledWith("browser");
  });

  it("keeps a pending approval visible while Chat is selected", async () => {
    await act(async () => {
      root.render(
        <ConversationSurfaceTabs
          activeId="chat"
          resourceId="browser" split={false} wide={false} ratio={.55} onSplitChange={() => {}}
          resources={[{ id: "browser", label: "Browser", panelId: "browser-panel", attention: <span data-testid="shared-browser-approval-attention">Approve</span> }]}
          chatPanelId="chat-panel"
          onSelect={vi.fn()}
        />,
      );
    });

    const browserTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-subtab-browser"]',
    );
    expect(browserTab?.getAttribute("aria-label")).toBe("Browser, approval needed");
    expect(container.querySelector('[data-testid="shared-browser-approval-attention"]')?.textContent).toBe(
      "Approve",
    );
  });
});
