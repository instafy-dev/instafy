// @vitest-environment jsdom

import { act } from "react";
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
      <Harness enabled onBack={drawer} priority={10} />
      <Harness enabled onBack={modal} priority={100} />
    </>));
    expect(appMock.addListener).toHaveBeenCalledTimes(1);
    act(() => handleBack?.());
    expect(modal).toHaveBeenCalledTimes(1);
    expect(drawer).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness enabled onBack={drawer} priority={10} />));
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
});
