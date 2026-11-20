// @vitest-environment jsdom

import { act, useState } from "react";
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

  describe("closing the Browser view", () => {
    // What a chat does with the Browser tab's close: the view goes, Chat comes forward.
    function Strip({ onClose, busy = false, split = false }: { onClose: () => void; busy?: boolean; split?: boolean }) {
      const [open, setOpen] = useState(true);
      const [activeId, setActiveId] = useState("browser");
      const browser = { id: "browser", label: "Browser", panelId: "browser-panel",
        busyLabel: busy ? "Octo is using the browser" : undefined,
        onClose: () => { onClose(); setOpen(false); setActiveId("chat"); } };
      const file = { id: "file:a.md", label: "a.md", panelId: "file-panel", onClose: vi.fn() };
      return <ConversationSurfaceTabs chatPanelId="chat-panel" split={split} wide={split} ratio={.55} onSplitChange={() => {}}
        resources={open ? [browser, file] : [file]} activeId={activeId} resourceId={open ? "browser" : "file:a.md"} onSelect={setActiveId} />;
    }
    const browserTab = () => container.querySelector<HTMLButtonElement>('[data-testid="conversation-subtab-browser"]');
    const closeButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Close Browser view"]');

    it("shows a close button on the Browser tab only when the chat can close it", async () => {
      await act(async () => root.render(<Strip onClose={vi.fn()} />));
      expect(closeButton()).not.toBeNull();
      expect(closeButton()?.type).toBe("button");
      expect(closeButton()?.closest('[data-tab-id="browser"]')).not.toBeNull();
      await act(async () => root.render(
        <ConversationSurfaceTabs chatPanelId="chat-panel" split={false} wide={false} ratio={.55} onSplitChange={() => {}} onSelect={vi.fn()}
          resources={[{ id: "browser", label: "Browser", panelId: "browser-panel" }]} activeId="browser" resourceId="browser" />,
      ));
      expect(browserTab()).not.toBeNull();
      expect(closeButton()).toBeNull();
    });

    it("closes from its button, hides the tab and moves focus to Chat", async () => {
      const onClose = vi.fn();
      await act(async () => root.render(<Strip onClose={onClose} />));
      await act(async () => closeButton()!.click());
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(browserTab()).toBeNull();
      const chatTab = container.querySelector<HTMLButtonElement>('[data-testid="conversation-subtab-chat"]')!;
      expect(chatTab.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(chatTab);
    });

    it("closes from the keyboard with Delete", async () => {
      const onClose = vi.fn();
      await act(async () => root.render(<Strip onClose={onClose} />));
      browserTab()!.focus();
      await act(async () => { browserTab()!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Delete" })); });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(browserTab()).toBeNull();
      expect(document.activeElement).toBe(container.querySelector('[data-testid="conversation-subtab-chat"]'));
    });

    it("closes at once while Octo is using the browser: the view goes, the turn is not asked about", async () => {
      const onClose = vi.fn();
      await act(async () => root.render(<Strip onClose={onClose} busy />));
      expect(browserTab()?.getAttribute("aria-label")).toBe("Browser, Octo is using the browser");
      await act(async () => closeButton()!.click());
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
      expect(browserTab()).toBeNull();
    });

    it("moves focus to Chat itself when Browser was the only view and the tab list hides", async () => {
      const chatPanel = Object.assign(document.createElement("div"), { id: "chat-panel", tabIndex: -1 });
      document.body.appendChild(chatPanel);
      function Only() {
        const [open, setOpen] = useState(true);
        return <ConversationSurfaceTabs chatPanelId="chat-panel" split={false} wide={false} ratio={.55} onSplitChange={() => {}} onSelect={vi.fn()}
          chatActions={<span>Participants</span>} activeId={open ? "browser" : "chat"} resourceId="browser"
          resources={open ? [{ id: "browser", label: "Browser", panelId: "browser-panel", onClose: () => setOpen(false) }] : []} />;
      }
      await act(async () => root.render(<Only />));
      await act(async () => closeButton()!.click());
      expect(container.querySelector('[role="tablist"]')?.hasAttribute("hidden")).toBe(true);
      expect(document.activeElement).toBe(chatPanel);
      chatPanel.remove();
    });

    it("hands its place beside Chat to the next view in a split", async () => {
      await act(async () => root.render(<Strip onClose={vi.fn()} split />));
      expect(container.querySelector('[data-testid="conversation-subtab-chat"]')).toBeNull();
      await act(async () => closeButton()!.click());
      const file = container.querySelector<HTMLButtonElement>('[data-testid="conversation-subtab-file:a.md"]')!;
      expect(file.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(file);
    });
  });

  it("names what a tab's marker means when it is not an approval", async () => {
    await act(async () => {
      root.render(
        <ConversationSurfaceTabs
          activeId="chat"
          resourceId="preview-1" split={false} wide={false} ratio={.55} onSplitChange={() => {}}
          resources={[{ id: "preview-1", label: "Cafés", panelId: "preview-panel", attention: <span>📍</span>, attentionLabel: "can see your location" }]}
          chatPanelId="chat-panel"
          onSelect={vi.fn()}
        />,
      );
    });
    expect(container.querySelector('[data-testid="conversation-subtab-preview-1"]')?.getAttribute("aria-label")).toBe("Cafés, can see your location");
  });
});
