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

  it("places participants over Chat in a split and hides them when only Browser is visible", async () => {
    const props = { chatPanelId: "chat-panel", resources: [{ id: "browser", label: "Browser", panelId: "browser-panel" }], activeId: "browser", resourceId: "browser", wide: true, ratio: .55, onSelect: vi.fn(), onSplitChange: vi.fn(), chatActions: <button>Participants</button> };
    await act(async () => root.render(<ConversationSurfaceTabs {...props} split />));
    expect(container.querySelector('[data-testid="conversation-chat-toolbar"]')?.textContent).toBe("ChatParticipants");
    expect(container.querySelector('[role="tablist"]')?.textContent).not.toContain("Participants");
    await act(async () => root.render(<ConversationSurfaceTabs {...props} split={false} />));
    expect(container.textContent).not.toContain("Participants");
    await act(async () => root.render(<ConversationSurfaceTabs {...props} resources={[]} activeId="chat" split={false} />));
    expect(container.querySelector('[data-testid="conversation-chat-toolbar"]')?.textContent).toBe("ChatParticipants");
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
    expect(browserTab?.className).toContain("min-h-11");

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
