// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileConversationSwitcher } from "../MobileConversationSwitcher";

const mocks = vi.hoisted(() => ({ nativeBack: vi.fn() }));
vi.mock("../../../../native/useNativeBackButtonAction", () => ({ useNativeBackButtonAction: mocks.nativeBack }));

describe("MobileConversationSwitcher", () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: ComponentProps<typeof MobileConversationSwitcher>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    props = {
      title: "Conversation 2", contextCaption: <span>Personal / FrontendQA</span>,
      spaceName: "FrontendQA", activeId: "current",
      tabs: [
        { id: "gateway", title: "Describe image", spaceName: "Gateway check", badge: "3" },
        { id: "current", title: "Conversation 2", spaceName: "FrontendQA" },
      ],
      onSelect: vi.fn(), onBrowseChats: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = () => act(async () => root.render(<MobileConversationSwitcher {...props} />));
  const query = <T extends HTMLElement = HTMLButtonElement>(suffix: string) =>
    document.querySelector<T>(`[data-testid="mobile-chat-switcher${suffix ? `-${suffix}` : ""}"]`);
  const rowIds = () => [...document.querySelectorAll('button[data-testid^="mobile-chat-switcher-tab-"]')]
    .map(row => row.getAttribute("data-testid")!.replace("mobile-chat-switcher-tab-", ""));

  async function click(suffix: string) {
    const target = query(suffix);
    expect(target).not.toBeNull();
    await act(async () => target!.click());
  }

  async function search(value: string) {
    const input = query<HTMLInputElement>("search");
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function withLongList() {
    props.tabs = [
      ...props.tabs,
      { id: "image-review", title: "Review image results", spaceName: "FrontendQA" },
      ...Array.from({ length: 4 }, (_, index) => ({ id: `extra-${index}`, title: `Work ${index}`, spaceName: "FrontendQA" })),
    ];
  }

  it("distinguishes organization open tabs from the current space's full chat directory", async () => {
    await render();
    await click("trigger");
    const dialog = query("")?.querySelector('[role="dialog"]');
    const heading = document.getElementById(dialog!.getAttribute("aria-labelledby")!);
    expect(heading?.textContent).toBe("Switch chat");
    expect(heading?.classList.contains("sr-only")).toBe(true);
    expect(query("")?.textContent).not.toContain("Personal");
    expect(document.querySelector('ul[aria-label="Open chats"]')).not.toBeNull();
    expect(query("search")).toBeNull();
    expect(query("spaces")).toBeNull();
    expect(rowIds()).toEqual(["gateway", "current"]);
    expect(query("tab-current")?.getAttribute("aria-current")).toBe("page");
    expect(query("tab-current")?.getAttribute("aria-label")).toContain("Conversation 2");
    expect(query("tab-current")?.getAttribute("aria-label")).toContain("FrontendQA");
    expect(query("tab-current")?.getAttribute("aria-label")).toContain("Current");
    expect(query("tab-gateway")?.getAttribute("aria-label")).toContain("Describe image");
    expect(query("tab-gateway")?.getAttribute("aria-label")).toContain("Gateway check");
    expect(query("tab-gateway")?.getAttribute("aria-label")).toContain("3 unread messages");
    expect(query("browse")?.textContent).toContain("All chats in this space");
    expect(query("browse")?.textContent).toContain("In FrontendQA");
    expect(query("browse")?.getAttribute("aria-label")).toBe("All chats in this space, FrontendQA");
    await click("browse");
    expect(props.onBrowseChats).toHaveBeenCalledOnce();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(query("")).toBeNull();
  });

  it("dismisses the current chat without navigating and selects another open chat once", async () => {
    await render();
    await click("trigger");
    await click("tab-current");
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(query("trigger")?.getAttribute("aria-expanded")).toBe("false");
    await click("trigger");
    await click("tab-gateway");
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith("gateway");
    expect(query("")).toBeNull();
  });

  it("filters longer lists by title or space without changing their open-tab order", async () => {
    withLongList();
    await render();
    await click("trigger");
    expect(query("search")?.getAttribute("aria-label")).toBe("Filter open chats");
    expect(query("search")?.getAttribute("placeholder")).toBe("Filter open chats");
    await search("  IMAGE  ");
    expect(rowIds()).toEqual(["gateway", "image-review"]);
    await search("  FRONTENDqa  ");
    expect(rowIds()).toEqual(["current", "image-review", "extra-0", "extra-1", "extra-2", "extra-3"]);
    await search("    ");
    expect(rowIds()).toEqual(props.tabs.map(tab => tab.id));
    await search("gateway");
    await click("tab-gateway");
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith("gateway");
    await click("trigger");
    expect(query<HTMLInputElement>("search")?.value).toBe("");
    expect(rowIds()).toEqual(props.tabs.map(tab => tab.id));
  });

  it("keeps the full chat directory reachable when no open tabs match the filter", async () => {
    withLongList();
    await render();
    await click("trigger");
    await search("not an open chat");
    expect(rowIds()).toEqual([]);
    expect(query("")?.textContent).toContain("No open chats match your search.");
    expect(query("browse")?.disabled).toBe(false);
    expect(query("browse")?.getAttribute("aria-label")).toBe("All chats in this space, FrontendQA");
    await click("browse");
    expect(props.onBrowseChats).toHaveBeenCalledOnce();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(query("")).toBeNull();
  });

  it("offers space switching beside chat browsing and clears the filter after switching", async () => {
    withLongList();
    props.onSwitchSpace = vi.fn();
    await render();
    await click("trigger");
    await search("not an open chat");
    expect(query("spaces")?.textContent).toContain("Switch space");
    expect(query("spaces")?.disabled).toBe(false);
    expect(query("browse")).not.toBeNull();
    await click("spaces");
    expect(props.onSwitchSpace).toHaveBeenCalledOnce();
    expect(props.onBrowseChats).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(query("")).toBeNull();
    expect(query("trigger")?.getAttribute("aria-expanded")).toBe("false");
    await click("trigger");
    expect(query<HTMLInputElement>("search")?.value).toBe("");
    expect(rowIds()).toEqual(props.tabs.map(tab => tab.id));
  });

  it.each(["Escape", "native Back", "trigger"])("resets the filter after %s dismisses the picker", async dismissal => {
    withLongList();
    await render();
    await click("trigger");
    await search("gateway");
    expect(rowIds()).toEqual(["gateway"]);
    if (dismissal === "native Back") {
      const [enabled, dismiss] = mocks.nativeBack.mock.lastCall!;
      expect(enabled).toBe(true);
      await act(async () => dismiss());
    } else if (dismissal === "Escape") {
      await act(async () => {
        query("search")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    } else {
      await click("trigger");
    }
    expect(query("")).toBeNull();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onBrowseChats).not.toHaveBeenCalled();
    await click("trigger");
    expect(query<HTMLInputElement>("search")?.value).toBe("");
    expect(rowIds()).toEqual(props.tabs.map(tab => tab.id));
  });

  it("does not present an empty open-tab list as an empty saved-chat history", async () => {
    props.tabs = [];
    props.activeId = null;
    await render();
    await click("trigger");
    expect(query("")?.textContent).toContain("No open chats yet.");
    expect(query("search")).toBeNull();
    expect(query("browse")).not.toBeNull();
    await click("browse");
    expect(props.onBrowseChats).toHaveBeenCalledOnce();
  });
});
