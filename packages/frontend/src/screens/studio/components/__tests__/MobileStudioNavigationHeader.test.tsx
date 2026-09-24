// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "../../../../components/Button";
import { MobileStudioNavigationHeader, type MobileStudioNavigationHeaderProps } from "../MobileStudioNavigationHeader";

const mocks = vi.hoisted(() => ({ nativeBack: vi.fn() }));
vi.mock("../../../../native/useNativeBackButtonAction", () => ({ useNativeBackButtonAction: mocks.nativeBack }));

describe("MobileStudioNavigationHeader", () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: MobileStudioNavigationHeaderProps;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement("div"); document.body.appendChild(container);
    root = createRoot(container);
    props = {
      history: { canGoBack: false, canGoForward: false, goBack: vi.fn(), goForward: vi.fn() },
      title: "A long conversation title", spaceName: "Alpha space",
      onOpenPicker: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); document.body.replaceChildren();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const render = () => act(async () => root.render(<MobileStudioNavigationHeader {...props} />));
  const query = (testId: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  async function click(testId: string) {
    const target = query(testId); expect(target).not.toBeNull();
    await act(async () => target!.click());
  }
  async function clickText(text: string) {
    const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text);
    expect(target).toBeDefined(); await act(async () => target!.click());
  }

  it("omits history controls at direct entry and keeps chats accessible through the sidebar", async () => {
    await render();
    expect(query("mobile-history-controls")).toBeNull();
    expect(query("mobile-header-open-chats")).toBeNull();
    await click("mobile-header-picker");
    expect(props.onOpenPicker).toHaveBeenCalledOnce();
    expect(props.history.goBack).not.toHaveBeenCalled();
  });

  it.each([[true, false], [false, true], [true, true]])("keeps a stable Back/Forward pair (back=%s, forward=%s)", async (canGoBack, canGoForward) => {
    props.history = { ...props.history, canGoBack, canGoForward };
    await render();
    expect(query("mobile-header-back")?.nextElementSibling).toBe(query("mobile-header-forward"));
    expect(query("mobile-header-back")?.disabled).toBe(!canGoBack);
    expect(query("mobile-header-forward")?.disabled).toBe(!canGoForward);
    expect(query("mobile-header-open-chats")).toBeNull();
    await click("mobile-header-back");
    await click("mobile-header-forward");
    expect(props.history.goBack).toHaveBeenCalledTimes(Number(canGoBack));
    expect(props.history.goForward).toHaveBeenCalledTimes(Number(canGoForward));
    expect(props.onOpenPicker).not.toHaveBeenCalled();
    expect(query("mobile-header-more")?.getAttribute("aria-expanded")).toBe("false");
    props.history = { ...props.history, canGoBack: false, canGoForward: false };
    await render();
    expect(query("mobile-history-controls")).toBeNull();
  });

  it("keeps chat history in More and dismisses the menu when a history direction is chosen", async () => {
    props.historyInMenu = true;
    props.history = { ...props.history, canGoBack: true, canGoForward: true };
    await render();
    expect(query("mobile-history-controls")).toBeNull();
    await click("mobile-header-more");
    expect(query("mobile-header-actions")?.contains(query("mobile-history-controls"))).toBe(true);
    await click("mobile-header-back");
    expect(props.history.goBack).toHaveBeenCalledOnce();
    expect(query("mobile-header-more")?.getAttribute("aria-expanded")).toBe("false");
    await click("mobile-header-more");
    await click("mobile-header-forward");
    expect(props.history.goForward).toHaveBeenCalledOnce();
    expect(query("mobile-header-more")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the sidebar control first and separate from the current location", async () => {
    props.titleIcon = <svg data-testid="chat-icon" />;
    await render();
    const picker = query("mobile-header-picker")!;
    expect(container.querySelector("button")).toBe(picker);
    expect(query("mobile-header-title")?.closest("button")).toBeNull();
    expect(query("chat-icon")?.closest('[data-testid="mobile-header-location"]')).not.toBeNull();
    expect(picker.getAttribute("aria-label")).toBe("Open space navigation: Alpha space");
    expect(picker.getAttribute("aria-haspopup")).toBe("dialog");
    expect(picker.getAttribute("aria-expanded")).toBe("false");
    expect(query("mobile-header-title")?.textContent).toBe(props.title);
    expect(query("mobile-header-space")?.textContent).toBe(props.spaceName);
    expect(query("mobile-header-title")?.classList.contains("truncate")).toBe(true);
    expect(query("mobile-header-space")?.classList.contains("truncate")).toBe(true);
    for (const button of container.querySelectorAll("button")) {
      expect(button.classList.contains("!min-h-12")).toBe(true);
      expect(button.classList.contains("!min-w-12")).toBe(true);
    }
    expect(document.activeElement).not.toBe(picker);
    await click("mobile-header-picker");
    expect(props.onOpenPicker).toHaveBeenCalledTimes(1);
    props.sidebarOpen = true;
    await render();
    expect(query("mobile-header-picker")?.getAttribute("aria-expanded")).toBe("true");
    expect(query("mobile-header-picker")?.getAttribute("aria-label")).toBe("Close space navigation: Alpha space");
    expect(container.querySelector("button")).toBe(query("mobile-header-picker"));
  });

  it("keeps secondary chat, parent and settings actions reachable and closes after each", async () => {
    const actions = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    Object.assign(props, {
      onNewChat: actions[0], onNewPrivateChat: actions[1],
      parentConversation: { title: "Parent", onOpen: actions[2] },
      onOpenSettings: actions[3],
    });
    await render();
    for (const [index, title] of ["Public chat", "Private chat", "Open parent conversationParent", "Space settings"].entries()) {
      await click("mobile-header-more");
      expect(query("mobile-header-actions")).not.toBeNull();
      // Observe the real shared Dialog/React Aria fallback, not just the
      // trigger label: the dialog must reference the named trigger in the DOM.
      const dialog = query("mobile-header-actions")!.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      const labelId = dialog!.getAttribute("aria-labelledby");
      expect(labelId).toBe(query("mobile-header-more")!.id);
      expect(document.getElementById(labelId!)?.getAttribute("aria-label")).toBe("More actions");
      for (const row of query("mobile-header-actions")!.querySelectorAll("button")) {
        if (row.getAttribute("aria-label") === "Dismiss") continue;
        expect(row.classList.contains("!min-h-12")).toBe(true);
      }
      await clickText(title);
      expect(actions[index]).toHaveBeenCalledTimes(1);
      expect(query("mobile-header-more")?.getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("preserves tab controls without a duplicate notification entry", async () => {
    const tabs = vi.fn();
    props.tabsAction = <Button onPress={tabs}>Browse tabs</Button>;
    await render(); await click("mobile-header-more");
    expect(document.body.textContent).not.toContain("Private chat");
    expect(document.body.textContent).not.toContain("Open parent conversation");
    expect(document.body.textContent).not.toContain("Notifications");
    await clickText("Browse tabs"); expect(tabs).toHaveBeenCalledTimes(1);
  });

  it("consumes native Back only while More is open, without navigating underneath", async () => {
    await render();
    expect(mocks.nativeBack).toHaveBeenLastCalledWith(false, expect.any(Function));
    await click("mobile-header-more");
    const [enabled, dismiss] = mocks.nativeBack.mock.lastCall!;
    expect(enabled).toBe(true);
    await act(async () => dismiss());
    expect(query("mobile-header-more")?.getAttribute("aria-expanded")).toBe("false");
    expect(mocks.nativeBack).toHaveBeenLastCalledWith(false, expect.any(Function));
    expect(props.history.goBack).not.toHaveBeenCalled();
  });

  it("drops an open menu when the owner changes route, account or space scope", async () => {
    for (const scope of [["account-a", "space-a", "visit-a"], ["account-a", "space-a", "visit-b"], ["account-b", "space-a", "visit-b"], ["account-b", "space-b", "visit-b"]]) {
      await act(async () => root.render(<MobileStudioNavigationHeader key={JSON.stringify(scope)} {...props} />));
      expect(query("mobile-header-more")?.getAttribute("aria-expanded")).toBe("false");
      await click("mobile-header-more");
      expect(query("mobile-header-more")?.getAttribute("aria-expanded")).toBe("true");
    }
  });
});
