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

function Harness({ enabled, onBack, priority }: { enabled: boolean; onBack: () => void; priority?: number }) {
  useNativeBackButtonAction(enabled, onBack, priority);
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

  it("uses one listener and dispatches only to the highest-priority surface", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    let handleBack: (() => void) | undefined;
    appMock.addListener.mockImplementation(async (_name: string, listener: () => void) => {
      handleBack = listener;
      return { remove };
    });
    const drawer = vi.fn(), modal = vi.fn();
    await act(async () => root.render(<>
      <Harness key="modal" enabled onBack={modal} priority={100} />
      <Harness key="drawer" enabled onBack={drawer} priority={10} />
    </>));
    expect(appMock.addListener).toHaveBeenCalledTimes(1);
    act(() => handleBack?.());
    expect(modal).toHaveBeenCalledTimes(1);
    expect(drawer).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness key="drawer" enabled onBack={drawer} priority={10} />));
    act(() => handleBack?.());
    expect(drawer).toHaveBeenCalledTimes(1);
    expect(appMock.addListener).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it("uses the latest callback without registering another listener", async () => {
    let handleBack: (() => void) | undefined;
    appMock.addListener.mockImplementation(async (_name: string, listener: () => void) => {
      handleBack = listener;
      return { remove: vi.fn().mockResolvedValue(undefined) };
    });
    const previous = vi.fn(), current = vi.fn();
    await act(async () => root.render(<Harness enabled onBack={previous} />));
    await act(async () => root.render(<Harness enabled onBack={current} />));
    act(() => handleBack?.());
    expect(current).toHaveBeenCalledTimes(1);
    expect(previous).not.toHaveBeenCalled();
    expect(appMock.addListener).toHaveBeenCalledTimes(1);
  });

  it("does not overlap native listeners when a surface reopens during async registration", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    let finish: ((handle: { remove: () => Promise<void> }) => void) | undefined;
    appMock.addListener.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<Harness enabled onBack={vi.fn()} />));
    await act(async () => root.render(<Harness enabled={false} onBack={vi.fn()} />));
    await act(async () => root.render(<Harness enabled onBack={vi.fn()} />));
    await act(async () => finish?.({ remove }));
    expect(appMock.addListener).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness enabled={false} onBack={vi.fn()} />));
    expect(remove).toHaveBeenCalledTimes(1);
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

  it("ignores a disposed bridge callback after an asynchronous close and reopen", async () => {
    let finishRemoval!: () => void;
    const removeOld = vi.fn(() => new Promise<void>((resolve) => { finishRemoval = resolve; }));
    const removeCurrent = vi.fn().mockResolvedValue(undefined);
    const callbacks: Array<() => void> = [];
    appMock.addListener.mockImplementation(async (_eventName: string, listener: () => void) => {
      callbacks.push(listener);
      return { remove: callbacks.length === 1 ? removeOld : removeCurrent };
    });
    const onBack = vi.fn();
    await act(async () => root.render(<Harness enabled onBack={onBack} />));
    await act(async () => root.render(null));
    await act(async () => root.render(<Harness enabled onBack={onBack} />));
    expect(appMock.addListener).toHaveBeenCalledOnce();
    expect(removeOld).toHaveBeenCalledOnce();
    await act(async () => finishRemoval());
    expect(appMock.addListener).toHaveBeenCalledTimes(2);
    act(() => callbacks.forEach((callback) => callback()));
    expect(onBack).toHaveBeenCalledOnce();
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
