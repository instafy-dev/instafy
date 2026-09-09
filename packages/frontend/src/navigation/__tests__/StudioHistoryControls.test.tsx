// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { isDesktopShell } from "../../lib/desktopShell";
import { StudioHistoryControls, studioHistoryControlsAvailable } from "../StudioHistoryControls";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }));
vi.mock("../../lib/desktopShell", () => ({ isDesktopShell: vi.fn(() => false) }));

describe("Studio history controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let navigate: ReturnType<typeof useNavigate>;
  let location: ReturnType<typeof useLocation>;
  let enabled: boolean | undefined;
  function Harness() {
    navigate = useNavigate();
    location = useLocation();
    return <StudioHistoryControls enabled={enabled} />;
  }
  const render = async () => { await act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>)); };
  const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  const click = async (name: string, expectNavigation = true) => {
    const previousKey = location.key;
    const shouldNavigate = expectNavigation && !button(name).disabled;
    await act(async () => {
      button(name).click();
      if (shouldNavigate) {
        await vi.waitFor(() => expect(window.history.state.key).not.toBe(previousKey));
      }
    });
    if (shouldNavigate) expect(location.key).not.toBe(previousKey);
  };
  const push = async (search: string, replace = false) => {
    await act(async () => { await navigate(`/studio?${search}`, { replace }); });
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(isDesktopShell).mockReturnValue(false);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    enabled = true;
    window.history.replaceState({ idx: 0, key: "start" }, "", "/studio?chat=A");
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

  it("uses shell detection and stays absent on ordinary web pages", async () => {
    enabled = undefined;
    await render();
    expect(container.querySelector("button")).toBeNull();
    expect(studioHistoryControlsAvailable()).toBe(false);
    vi.mocked(isDesktopShell).mockReturnValue(true);
    await render();
    expect(button("Go back")).not.toBeNull();
    vi.mocked(isDesktopShell).mockReturnValue(false);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    expect(studioHistoryControlsAvailable()).toBe(true);
  });

  it("traverses exact Router entries and disables Back at the initial entry", async () => {
    expect(button("Go back").disabled).toBe(true);
    expect(button("Go forward").disabled).toBe(true);
    await push("chat=B");
    const middleKey = location.key;
    await push("chat=A");
    const lastKey = location.key;
    expect(button("Go back").disabled).toBe(false);
    expect(button("Go forward").disabled).toBe(true);
    await click("Go back");
    expect(location.key).toBe(middleKey);
    expect(button("Go forward").disabled).toBe(false);
    await click("Go back");
    expect(location.key).toBe("start");
    expect(button("Go back").disabled).toBe(true);
    await click("Go forward");
    expect(location.key).toBe(middleKey);
    await click("Go forward");
    expect(location.key).toBe(lastKey);
    expect(button("Go forward").disabled).toBe(true);
  });

  it("preserves known forward entries across replace but resets them on a new push", async () => {
    await push("chat=B"); await push("chat=C");
    await click("Go back");
    await push("chat=B&canonical=1", true);
    expect(button("Go forward").disabled).toBe(false);
    await click("Go back");
    await push("chat=D");
    expect(button("Go forward").disabled).toBe(true);
    await click("Go forward");
    expect(location.search).toBe("?chat=D");
  });

  it("does not invent forward history after remount", async () => {
    await push("chat=B"); await push("chat=C"); await click("Go back");
    expect(button("Go forward").disabled).toBe(false);
    enabled = false; await render(); enabled = true; await render();
    expect(button("Go back").disabled).toBe(false);
    expect(button("Go forward").disabled).toBe(true);
  });

  it("fails closed for malformed or stale non-Router history state", async () => {
    await push("chat=B");
    const back = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    window.history.replaceState({ idx: 5, key: "not-rendered" }, "", "/studio?chat=C");
    await click("Go back", false);
    expect(back).not.toHaveBeenCalled();
    for (const idx of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, undefined]) {
      window.history.replaceState({ idx, key: location.key }, "", window.location.href);
      await render();
      expect(button("Go back").disabled).toBe(true);
      expect(button("Go forward").disabled).toBe(true);
    }
  });
});
