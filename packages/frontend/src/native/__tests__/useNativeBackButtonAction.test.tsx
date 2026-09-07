// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeBackButtonAction } from "../useNativeBackButtonAction";

const appMock = vi.hoisted(() => ({
  addListener: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: vi.fn(),
    getPlatform: vi.fn(),
  },
}));

vi.mock("@capacitor/app", () => ({
  App: appMock,
}));

function Harness({ enabled, onBack }: { enabled: boolean; onBack: () => void }) {
  useNativeBackButtonAction(enabled, onBack);
  return null;
}

describe("useNativeBackButtonAction", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    appMock.addListener.mockReset();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Capacitor.getPlatform).mockReturnValue("android");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("consumes Back only while the native surface is enabled", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    let handleBack: (() => void) | undefined;
    appMock.addListener.mockImplementation(async (_eventName: string, listener: () => void) => {
      handleBack = listener;
      return { remove };
    });
    const onBack = vi.fn();

    await act(async () => root.render(<Harness enabled onBack={onBack} />));
    await vi.waitFor(() => {
      expect(appMock.addListener).toHaveBeenCalledWith("backButton", expect.any(Function));
    });
    act(() => handleBack?.());
    expect(onBack).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<Harness enabled={false} onBack={onBack} />));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("does not install a browser listener", async () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue("web");

    await act(async () => root.render(<Harness enabled onBack={vi.fn()} />));

    expect(appMock.addListener).not.toHaveBeenCalled();
  });

  it("delivers each Back only to the latest enabled surface and resumes the previous one after dismissal", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    let handleBack: (() => void) | undefined;
    appMock.addListener.mockImplementation(async (_eventName: string, listener: () => void) => {
      handleBack = listener;
      return { remove };
    });
    const outer = vi.fn();
    const inner = vi.fn();
    const updatedInner = vi.fn();
    const render = (innerEnabled: boolean, onInner = inner) => root.render(<>
      <Harness enabled onBack={outer} />
      <Harness enabled={innerEnabled} onBack={onInner} />
    </>);

    await act(async () => render(false));
    await act(async () => render(true));
    expect(appMock.addListener).toHaveBeenCalledOnce();
    act(() => handleBack?.());
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    await act(async () => render(true, updatedInner));
    act(() => handleBack?.());
    expect(updatedInner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    await act(async () => render(false));
    expect(remove).not.toHaveBeenCalled();
    act(() => handleBack?.());
    expect(outer).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    expect(remove).toHaveBeenCalledOnce();
  });

  it("ignores stale bridge callbacks when a listener finishes registering after close and reopen", async () => {
    const removeOld = vi.fn().mockResolvedValue(undefined);
    const removeCurrent = vi.fn().mockResolvedValue(undefined);
    let resolveOld!: (listener: { remove: typeof removeOld }) => void;
    const callbacks: Array<() => void> = [];
    appMock.addListener.mockImplementation((_eventName: string, listener: () => void) => {
      callbacks.push(listener);
      return callbacks.length === 1
        ? new Promise((resolve) => { resolveOld = resolve; })
        : Promise.resolve({ remove: removeCurrent });
    });
    const onBack = vi.fn();
    await act(async () => root.render(<Harness enabled onBack={onBack} />));
    await act(async () => root.render(null));
    await act(async () => root.render(<Harness enabled onBack={onBack} />));
    act(() => callbacks.forEach((callback) => callback()));
    expect(onBack).toHaveBeenCalledOnce();
    await act(async () => resolveOld({ remove: removeOld }));
    expect(removeOld).toHaveBeenCalledOnce();
    expect(removeCurrent).not.toHaveBeenCalled();
  });

  it("keeps one effective handler through StrictMode remounts", async () => {
    const callbacks: Array<() => void> = [];
    const remove = vi.fn().mockResolvedValue(undefined);
    appMock.addListener.mockImplementation(async (_eventName: string, listener: () => void) => {
      callbacks.push(listener);
      return { remove };
    });
    const onBack = vi.fn();
    await act(async () => root.render(<StrictMode><Harness enabled onBack={onBack} /></StrictMode>));
    act(() => callbacks.forEach((callback) => callback()));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
