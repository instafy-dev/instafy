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
});
