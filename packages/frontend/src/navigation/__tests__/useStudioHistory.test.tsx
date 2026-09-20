// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudioHistory, type StudioHistory } from "../useStudioHistory";

describe("persistent Studio history owner", () => {
  let container: HTMLDivElement;
  let root: Root;
  let navigate: ReturnType<typeof useNavigate>;
  let location: ReturnType<typeof useLocation>;
  let history: StudioHistory;
  let secondaryVisible: boolean;

  function Harness() {
    navigate = useNavigate();
    location = useLocation();
    history = useStudioHistory();
    return secondaryVisible ? (
      <button disabled={!history.canGoForward} onClick={history.goForward}>Secondary Forward</button>
    ) : null;
  }
  const render = async () => {
    await act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>));
  };
  const push = async (chat: string, replace = false) => {
    await act(async () => { await navigate(`/studio?chat=${chat}`, { replace }); });
  };
  const move = async (action: () => void) => {
    const previousKey = location.key;
    await act(async () => {
      action();
      await vi.waitFor(() => expect(window.history.state.key).not.toBe(previousKey));
    });
    expect(location.key).not.toBe(previousKey);
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({ idx: 0, key: "initial" }, "", "/studio?chat=A");
    secondaryVisible = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("retains Forward while a secondary presentation mounts and unmounts", async () => {
    expect(history.canGoBack).toBe(false);
    expect(history.canGoForward).toBe(false);
    await push("B");
    const middleKey = location.key;
    await push("A");
    const lastKey = location.key;
    await move(history.goBack);
    expect(location.key).toBe(middleKey);
    expect(history.canGoForward).toBe(true);
    secondaryVisible = true; await render();
    expect(container.querySelector("button")?.disabled).toBe(false);
    secondaryVisible = false; await render();
    expect(container.querySelector("button")).toBeNull();
    expect(history.canGoForward).toBe(true);
    secondaryVisible = true; await render();
    await move(() => container.querySelector("button")!.click());
    expect(location.key).toBe(lastKey);
    expect(history.canGoForward).toBe(false);
  });

  it("keeps replacement forward history but truncates it after a new push", async () => {
    await push("B"); await push("C");
    const finalKey = location.key;
    await move(history.goBack);
    await push("B-canonical", true);
    expect(history.canGoForward).toBe(true);
    await move(history.goForward);
    expect(location.key).toBe(finalKey);
    await move(history.goBack);
    await push("D");
    expect(history.canGoForward).toBe(false);
    const go = vi.spyOn(window.history, "go");
    history.goForward();
    expect(go).not.toHaveBeenCalled();
  });

  it("rejects a saved action after another entry commits before Router catches up", async () => {
    await push("B"); await push("C"); await move(history.goBack);
    const staleBack = history.goBack;
    const staleForward = history.goForward;
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    window.history.pushState({ idx: 2, key: "unrendered" }, "", "/studio?chat=D");
    staleBack(); staleForward();
    expect(go).not.toHaveBeenCalled();
  });

  it("keeps Back and Forward stable while a scope update renders ahead of Router", async () => {
    await push("B"); await push("C"); await move(history.goBack);
    expect(history.canGoBack).toBe(true);
    expect(history.canGoForward).toBe(true);
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);

    // The org/space context can render the old Router location after the
    // browser has committed a new entry. This is not a direct-entry visit.
    window.history.pushState({ idx: 2, key: "next-org" }, "", "/studio?chat=D");
    await render();
    expect(history.canGoBack).toBe(true);
    expect(history.canGoForward).toBe(true);
    history.goBack(); history.goForward();
    expect(go).not.toHaveBeenCalled();

    // Once Router publishes the entry, the new push truncates Forward.
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state })));
    expect(location.key).toBe("next-org");
    expect(history.canGoBack).toBe(true);
    expect(history.canGoForward).toBe(false);
  });

  it("still recognizes the real first visit when returning to it", async () => {
    await push("B");
    await move(history.goBack);
    expect(history.canGoBack).toBe(false);
    expect(history.canGoForward).toBe(true);
  });
});
