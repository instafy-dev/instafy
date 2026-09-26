// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate, type NavigateOptions } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOME_LIST_STATE, useStudioListNavigation } from "../StudioListNavigation";

describe("list origins and visit state", () => {
  let root: Root;
  let container: HTMLDivElement;
  let navigate: ReturnType<typeof useNavigate>;
  let location: ReturnType<typeof useLocation>;
  let navigation: ReturnType<typeof useStudioListNavigation>;
  let user = "user-a";
  function Harness() {
    navigate = useNavigate(); location = useLocation();
    navigation = useStudioListNavigation(user);
    return null;
  }
  const render = async () => { await act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>)); };
  const push = async (search: string, options?: NavigateOptions) => {
    await act(async () => { await navigate(`/studio?${search}`, options); });
  };
  const move = async (action: () => void) => {
    const key = location.key;
    await act(async () => { action(); await vi.waitFor(() => expect(window.history.state.key).not.toBe(key)); });
  };
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({ idx: 0, key: "home" }, "", "/studio?panel=home&projectId=old-space");
    user = "user-a";
    container = document.createElement("div"); document.body.appendChild(container);
    root = createRoot(container); await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it("returns across spaces to the filtered, expanded Home visit and supports Forward", async () => {
    const state = { ...DEFAULT_HOME_LIST_STATE, teamFilter: "other-team", recentLimit: 72, activityPages: 3, needsExpanded: true };
    await act(async () => navigation.setState("home", state, DEFAULT_HOME_LIST_STATE));
    const homeScroll = navigation.scrollIdentity;
    await push("projectId=other-space&conversationControllerId=chat-b");
    expect(navigation.returnLabel).toBe("Back to Home");
    const chatKey = location.key;
    await push("projectId=other-space&conversationControllerId=chat-b&conversationId=local-b", { replace: true, state: { instafyVisitKey: chatKey } });
    expect(navigation.returnLabel).toBe("Back to Home");
    await move(navigation.returnToList);
    expect(location.search).toContain("panel=home");
    expect(navigation.getState("home", DEFAULT_HOME_LIST_STATE)).toEqual(state);
    expect(navigation.scrollIdentity).toBe(homeScroll);
    await move(() => { void navigate(1); });
    expect(navigation.returnLabel).toBe("Back to Home");
  });
  it("keeps Chats query and filter on Back, but starts a fresh visit clean", async () => {
    await push("projectId=space-a&workspaceTab=history&conversationId=chat-a");
    await act(async () => {
      navigation.setState("chat-query", "release", "");
      navigation.setState("chat-filter", "unread", "all");
    });
    await push("projectId=space-a&conversationId=chat-b");
    expect(navigation.returnLabel).toBe("Back to chats");
    await move(navigation.returnToList);
    expect(navigation.getState("chat-query", "")).toBe("release");
    expect(navigation.getState("chat-filter", "all")).toBe("unread");
    await push("projectId=space-a&workspaceTab=history");
    expect(navigation.getState("chat-query", "")).toBe("");
  });
  it("does not treat arbitrary settings or a direct chat as a list origin", async () => {
    await push("panel=settings&projectId=space-a");
    await push("projectId=space-a&conversationId=chat-a");
    expect(navigation.returnLabel).toBeNull();
  });
  it("clears state and rejects stale actions after account changes", async () => {
    await act(async () => navigation.setState("home", { ...DEFAULT_HOME_LIST_STATE, teamFilter: "private" }, DEFAULT_HOME_LIST_STATE));
    await push("projectId=space-b&conversationId=chat-b");
    const oldReturn = navigation.returnToList;
    user = "user-b"; await render();
    expect(navigation.returnLabel).toBeNull();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    oldReturn(); expect(go).not.toHaveBeenCalled();
    await push("panel=home");
    expect(navigation.getState("home", DEFAULT_HOME_LIST_STATE)).toEqual(DEFAULT_HOME_LIST_STATE);
  });

  it("remembers opened chats across teams by ID, rather than Home's retained conversation or activity time", async () => {
    await push("projectId=space-a&conversationControllerId=chat-a");
    await push("panel=home&projectId=space-a&conversationControllerId=retained");
    await push("projectId=space-b&conversationControllerId=chat-b&panel=chat");
    expect(navigation.recentChatKeys).toEqual([JSON.stringify(["space-b", "chat-b"]), JSON.stringify(["space-a", "chat-a"])]);
    await push("projectId=space-a&conversationControllerId=chat-a");
    expect(navigation.recentChatKeys).toEqual([JSON.stringify(["space-a", "chat-a"]), JSON.stringify(["space-b", "chat-b"])]);
    user = "user-b"; await render();
    expect(navigation.recentChatKeys).toEqual([JSON.stringify(["space-a", "chat-a"])]);
    // The new account may visit the current URL, but inherits no other team's history.
  });
  it("guards double presses and actions from a stale browser entry", async () => {
    await push("projectId=space-b&conversationId=chat-b");
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    navigation.returnToList(); navigation.returnToList();
    expect(go).toHaveBeenCalledTimes(1);
    window.history.pushState({ idx: 2, key: "ahead" }, "", "/studio?panel=settings");
    navigation.returnToList(); expect(go).toHaveBeenCalledTimes(1);
  });
});
