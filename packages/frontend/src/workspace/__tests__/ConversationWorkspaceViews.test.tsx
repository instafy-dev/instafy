// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationWorkspaceViews } from "../ConversationWorkspaceViews";
import { DEFAULT_CONVERSATION_SURFACES } from "../conversationSurfaces";
import type { ConversationBrowserState } from "../WorkspaceTabsProvider";

const workspaceTabs = vi.hoisted(() => {
  const state = { conversationBrowser: { available: true, attention: false } as ConversationBrowserState };
  return Object.assign(state, {
    setConversationBrowser: vi.fn((_scope: string | null, next: ConversationBrowserState) => { state.conversationBrowser = next; }),
    updateSurfaces: vi.fn(),
    openConversationTab: vi.fn(),
  });
});

vi.mock("../WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    conversationWorkspace: true,
    conversationWorkspaceScope: "scope-1",
    conversationSurfaces: { read: () => DEFAULT_CONVERSATION_SURFACES, update: workspaceTabs.updateSurfaces },
    conversationBrowser: workspaceTabs.conversationBrowser,
    setConversationBrowser: workspaceTabs.setConversationBrowser,
    activeTab: { id: "tab-1", kind: "conversation", conversationId: "conversation-1" },
    tabs: [],
    openConversationTab: workspaceTabs.openConversationTab,
    focusTab: vi.fn(),
    closeTab: vi.fn(),
    requestUrlPush: vi.fn(),
  }),
}));
vi.mock("../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({ conversations: [{ localId: "conversation-1", controllerId: null }] }),
}));
vi.mock("../../code/useCode", () => ({ useCode: () => ({ workspace: { files: [] } }) }));
vi.mock("../../screens/studio/useStudioNavigationPosture", () => ({
  useStudioNavigationPosture: () => ({ isLargeScreen: true }),
}));
vi.mock("../../screens/studio/components/ConversationRoster", () => ({ ConversationRoster: () => null }));

async function renderViews(root: Root) {
  await act(async () => root.render(<ConversationWorkspaceViews />));
}

describe("ConversationWorkspaceViews", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps a Browser tab for a hidden browser, naming the tab a message goes to", async () => {
    workspaceTabs.conversationBrowser = { available: true, attention: false, pageTitle: "Belém Tower · Visit Lisboa", agentName: null };
    await renderViews(root);
    const tab = container.querySelector<HTMLButtonElement>('[data-testid="conversation-subtab-browser"]')!;
    expect(tab).not.toBeNull();
    expect(tab.title).toBe("Browser · Belém Tower · Visit Lisboa");
    const description = document.getElementById(tab.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Browser · Belém Tower · Visit Lisboa");
    expect(tab.getAttribute("aria-label")).toBe("Browser");
    expect(container.querySelector('[data-testid="conversation-subtab-browser-busy"]')).toBeNull();
  });

  it("shows a quiet dot, named for screen readers, while the agent uses the browser", async () => {
    workspaceTabs.conversationBrowser = { available: true, attention: false, pageTitle: null, agentName: "Octo" };
    await renderViews(root);
    const tab = container.querySelector<HTMLButtonElement>('[data-testid="conversation-subtab-browser"]')!;
    const dot = container.querySelector('[data-testid="conversation-subtab-browser-busy"]');
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.className).toContain("bg-violet-500");
    expect(tab.getAttribute("aria-label")).toBe("Browser, Octo is using the browser");
    expect(tab.title).toBe("Browser");
    expect(tab.hasAttribute("aria-describedby")).toBe(false);
  });

  it("has no Browser tab when the conversation has no browser", async () => {
    workspaceTabs.conversationBrowser = { available: false, attention: false };
    await renderViews(root);
    expect(container.querySelector('[data-testid="conversation-subtab-browser"]')).toBeNull();
  });

  it("closes the Browser view with the chat's own close, and the tab goes at once", async () => {
    const close = vi.fn();
    workspaceTabs.setConversationBrowser.mockClear();
    workspaceTabs.conversationBrowser = { available: true, attention: false, pageTitle: null, agentName: "Octo", close };
    await renderViews(root);
    const closeButton = container.querySelector<HTMLButtonElement>('[aria-label="Close Browser view"]');
    expect(closeButton?.closest('[data-tab-id="browser"]')).not.toBeNull();
    await act(async () => closeButton!.click());
    // The chat closes its view; the tab does not wait for its panel to say so
    // (one of the chat's own tabs may be in front of it).
    expect(close).toHaveBeenCalledTimes(1);
    expect(workspaceTabs.setConversationBrowser).toHaveBeenCalledWith("scope-1", { available: false, offered: false, attention: false, pageTitle: null, agentName: "Octo", close });
    await renderViews(root);
    expect(container.querySelector('[data-testid="conversation-subtab-browser"]')).toBeNull();
  });

  it("offers no close where no chat panel said how to close its view", async () => {
    workspaceTabs.conversationBrowser = { available: true, attention: false };
    await renderViews(root);
    expect(container.querySelector('[data-testid="conversation-subtab-browser"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Close Browser view"]')).toBeNull();
  });

  // Dogfood, Nov 22: Octo's pause on a sign-in still waited after a reload,
  // but the chat had no Browser tab to go back to it.
  it("keeps a Browser tab a waiting pause offers, which selects the Browser view", async () => {
    workspaceTabs.updateSurfaces.mockClear();
    workspaceTabs.openConversationTab.mockClear();
    workspaceTabs.conversationBrowser = { available: false, offered: true, attention: false, pageTitle: null, agentName: null };
    await renderViews(root);
    const tab = container.querySelector<HTMLButtonElement>('[data-testid="conversation-subtab-browser"]');
    expect(tab).not.toBeNull();
    // Chat stays the view in front until the chat's panel opens the browser.
    expect(container.querySelector('[data-testid="conversation-subtab-chat"]')?.getAttribute("aria-selected")).toBe("true");
    await act(async () => tab!.click());
    expect(workspaceTabs.updateSurfaces).toHaveBeenCalledTimes(1);
    const [scope, change] = workspaceTabs.updateSurfaces.mock.calls[0] as [string, (state: typeof DEFAULT_CONVERSATION_SURFACES) => typeof DEFAULT_CONVERSATION_SURFACES];
    expect(scope).toBe("scope-1");
    expect(change(DEFAULT_CONVERSATION_SURFACES).activeId).toBe("browser");
    expect(workspaceTabs.openConversationTab).toHaveBeenCalledWith("conversation-1");
  });

  it("counts an offered tab as no open view: the bar does not split for it", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    try {
      workspaceTabs.conversationBrowser = { available: false, offered: true, attention: false };
      await renderViews(root);
      expect(container.querySelector('[data-testid="conversation-chat-toolbar"]')).toBeNull();
      expect(container.querySelector('[data-testid="conversation-subtab-chat"]')).not.toBeNull();
      // An open view beside Chat does split it.
      workspaceTabs.conversationBrowser = { available: true, attention: false };
      await renderViews(root);
      expect(container.querySelector('[data-testid="conversation-chat-toolbar"]')).not.toBeNull();
    } finally {
      width.mockRestore();
    }
  });

  it("withdraws the offer when the person closes that tab", async () => {
    const close = vi.fn();
    workspaceTabs.setConversationBrowser.mockClear();
    workspaceTabs.conversationBrowser = { available: false, offered: true, attention: false, pageTitle: null, agentName: null, close };
    await renderViews(root);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Browser view"]')!.click());
    expect(close).toHaveBeenCalledTimes(1);
    expect(workspaceTabs.setConversationBrowser).toHaveBeenCalledWith("scope-1", expect.objectContaining({ available: false, offered: false }));
    await renderViews(root);
    expect(container.querySelector('[data-testid="conversation-subtab-browser"]')).toBeNull();
  });
});
