// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConversationQuickTabs } from "../ConversationQuickTabs";
import type { WorkspaceConversationTabState } from "../workspaceTabFactories";

it("selects chats, keeps previews, and restores keyboard focus after closing", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  const tabs: WorkspaceConversationTabState[] = ["One", "Two"].map(title => ({ id: title, conversationId: title, title, kind: "conversation", preview: title === "Two", closable: true, dirty: false, badge: null, draggable: true }));
  const onSelect = vi.fn(), onKeep = vi.fn(), onClose = vi.fn();
  const render = (items = tabs, active = "One") => root.render(<ConversationQuickTabs tabs={items} activeId={active} scopeName="Workshop" onSelect={onSelect} onKeep={onKeep} onClose={onClose} />);
  try {
    await act(async () => render());
    const first = node.querySelector<HTMLButtonElement>('[aria-current="page"]')!;
    expect(first.textContent).toBe("One");
    await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("Two");
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(onSelect).toHaveBeenCalledWith("Two");
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Keep Two open"]')!.click());
    expect(onKeep).toHaveBeenCalledWith("Two");
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Close One tab"]')!.click());
    expect(onClose).toHaveBeenCalledWith("One");
    await act(async () => render([tabs[1]], "Two"));
    expect(document.activeElement?.textContent).toBe("Two");
    expect(document.activeElement?.getAttribute("aria-current")).toBe("page");
  } finally {
    await act(async () => root.unmount()); node.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

// A prompt waited 2 minutes in one chat while the person was in another, and
// nothing on that chat's tab said so.
it("says Approve on the tab of a chat whose browser prompt waits, and only there", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  const tabs = [
    { id: "porto", title: "Open visitporto.travel in your browser", attention: true },
    { id: "seville", title: "Plan 3 days in Seville" },
  ];
  try {
    await act(async () => root.render(<ConversationQuickTabs tabs={tabs} activeId="seville" scopeName="Workshop" onSelect={vi.fn()} onKeep={vi.fn()} onClose={vi.fn()} />));
    const porto = node.querySelector<HTMLButtonElement>('[data-tab-id="porto"] button')!;
    const seville = node.querySelector<HTMLButtonElement>('[data-tab-id="seville"] button')!;
    expect(porto.textContent).toBe("Open visitporto.travel in your browserApprove");
    expect(porto.getAttribute("aria-label")).toBe("Open visitporto.travel in your browser, approval needed");
    expect(seville.textContent).toBe("Plan 3 days in Seville");
    expect(seville.getAttribute("aria-label")).toBe("Plan 3 days in Seville");
  } finally {
    await act(async () => root.unmount()); node.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
