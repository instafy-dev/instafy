// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeBackButtonAction } from "../../native/useNativeBackButtonAction";
import { useStudioLayoutChromeState } from "../useStudioLayoutChromeState";

const native = vi.hoisted(() => ({ addListener: vi.fn() }));
vi.mock("@capacitor/app", () => ({ App: native }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
}));

describe("Studio sidebar native and keyboard Back integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let chrome: ReturnType<typeof useStudioLayoutChromeState>;
  let onNativeBack: () => void;
  let modalOpen: boolean;
  const onModalBack = vi.fn();
  const remove = vi.fn();
  function Harness() {
    chrome = useStudioLayoutChromeState({ isLargeScreen: false, scopeKey: "user:project" });
    useNativeBackButtonAction(modalOpen, onModalBack);
    return null;
  }
  const render = async () => { await act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>)); };
  const wait = async (assertion: () => void) => {
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
      assertion();
    });
  };
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({ idx: 0, key: "base", usr: null }, "", "/studio?panel=chat");
    modalOpen = false;
    onModalBack.mockReset();
    remove.mockReset().mockResolvedValue(undefined);
    native.addListener.mockReset().mockImplementation(async (_name: string, listener: () => void) => {
      onNativeBack = listener;
      return { remove };
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("uses one native handler: a modal wins, then Back pops drill-in, drawer, and restores the default", async () => {
    expect(native.addListener).not.toHaveBeenCalled();
    await act(async () => chrome.setMobileSidebarOpen(true));
    await act(async () => chrome.mobileSidebarNavigation.openView("workspace"));
    modalOpen = true;
    await render();
    await act(async () => onNativeBack());
    expect(onModalBack).toHaveBeenCalledTimes(1);
    expect(chrome.mobileSidebarNavigation.view).toBe("workspace");
    expect(native.addListener).toHaveBeenCalledTimes(1);
    modalOpen = false;
    await render();
    await act(async () => onNativeBack());
    await wait(() => expect(chrome.mobileSidebarNavigation.view).toBe("sidebar"));
    await act(async () => onNativeBack());
    await wait(() => expect(chrome.mobileSidebarOpen).toBe(false));
    expect(window.history.state.key).toBe("base");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("leaves a consumed Escape alone and otherwise pops only one layer", async () => {
    await act(async () => chrome.setMobileSidebarOpen(true));
    await act(async () => chrome.mobileSidebarNavigation.openView("more"));
    const consumed = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    consumed.preventDefault();
    await act(async () => { window.dispatchEvent(consumed); });
    expect(chrome.mobileSidebarNavigation.view).toBe("more");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    await wait(() => expect(chrome.mobileSidebarNavigation.view).toBe("sidebar"));
  });
});
