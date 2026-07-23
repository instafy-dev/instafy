// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  addAppListenerMock,
  isNativePlatformMock,
  removeAppListenerMock,
  setStatusBarBackgroundColorMock,
  setStatusBarStyleMock,
} = vi.hoisted(() => ({
  addAppListenerMock: vi.fn(),
  isNativePlatformMock: vi.fn(),
  removeAppListenerMock: vi.fn(),
  setStatusBarBackgroundColorMock: vi.fn(),
  setStatusBarStyleMock: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: isNativePlatformMock,
  },
}));

vi.mock("@capacitor/status-bar", () => ({
  StatusBar: {
    setBackgroundColor: setStatusBarBackgroundColorMock,
    setStyle: setStatusBarStyleMock,
  },
  Style: {
    Dark: "DARK",
    Light: "LIGHT",
  },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: addAppListenerMock,
  },
}));

import { ThemeProvider } from "../ThemeProvider";

let container: HTMLDivElement;
let root: Root;

function matchMedia(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
}

async function renderTheme(mode: "system" | "light" | "dark", children: ReactNode = null) {
  window.localStorage.setItem("instafy.themeMode", mode);
  await act(async () => {
    root.render(<ThemeProvider>{children}</ThemeProvider>);
  });
  await vi.waitFor(() => expect(setStatusBarStyleMock).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => matchMedia(false)),
  });
  window.localStorage.clear();
  isNativePlatformMock.mockReset();
  isNativePlatformMock.mockReturnValue(true);
  removeAppListenerMock.mockReset();
  removeAppListenerMock.mockResolvedValue(undefined);
  addAppListenerMock.mockReset();
  addAppListenerMock.mockResolvedValue({ remove: removeAppListenerMock });
  setStatusBarStyleMock.mockReset();
  setStatusBarStyleMock.mockResolvedValue(undefined);
  setStatusBarBackgroundColorMock.mockReset();
  setStatusBarBackgroundColorMock.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("ThemeProvider native system bars", () => {
  it("uses dark status-bar icons for the light app theme", async () => {
    await renderTheme("light");

    expect(setStatusBarStyleMock).toHaveBeenCalledWith({ style: "LIGHT" });
    expect(setStatusBarBackgroundColorMock).toHaveBeenCalledWith({ color: "#ffffff" });
  });

  it("uses light status-bar icons for the dark app theme", async () => {
    await renderTheme("dark");

    expect(setStatusBarStyleMock).toHaveBeenCalledWith({ style: "DARK" });
    expect(setStatusBarBackgroundColorMock).toHaveBeenCalledWith({ color: "#181818" });
  });

  it("tracks the system theme and reapplies the latest resolution on focus", async () => {
    let prefersDark = false;
    let notifyThemeChange: (() => void) | undefined;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        get matches() {
          return prefersDark;
        },
        media: "(prefers-color-scheme: dark)",
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => {
          notifyThemeChange = listener;
        },
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    await renderTheme("system");
    expect(setStatusBarStyleMock).toHaveBeenLastCalledWith({ style: "LIGHT" });

    prefersDark = true;
    await act(async () => notifyThemeChange?.());
    await vi.waitFor(() => {
      expect(setStatusBarStyleMock).toHaveBeenLastCalledWith({ style: "DARK" });
      expect(setStatusBarBackgroundColorMock).toHaveBeenLastCalledWith({ color: "#181818" });
    });
    setStatusBarStyleMock.mockClear();
    setStatusBarBackgroundColorMock.mockClear();

    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => {
      expect(setStatusBarStyleMock).toHaveBeenCalledWith({ style: "DARK" });
      expect(setStatusBarBackgroundColorMock).toHaveBeenCalledWith({ color: "#181818" });
    });
  });

  it("restores the selected native theme when the WebView regains focus", async () => {
    await renderTheme("dark");
    setStatusBarStyleMock.mockClear();
    setStatusBarBackgroundColorMock.mockClear();

    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => {
      expect(setStatusBarStyleMock).toHaveBeenCalledWith({ style: "DARK" });
      expect(setStatusBarBackgroundColorMock).toHaveBeenCalledWith({ color: "#181818" });
    });
  });

  it("restores the selected native theme after a viewport configuration change", async () => {
    await renderTheme("light");
    setStatusBarStyleMock.mockClear();
    setStatusBarBackgroundColorMock.mockClear();

    window.dispatchEvent(new Event("resize"));

    await vi.waitFor(() => {
      expect(setStatusBarStyleMock).toHaveBeenCalledWith({ style: "LIGHT" });
      expect(setStatusBarBackgroundColorMock).toHaveBeenCalledWith({ color: "#ffffff" });
    });
  });

  it("restores the selected native theme when the app becomes active", async () => {
    await renderTheme("light");
    await vi.waitFor(() => expect(addAppListenerMock).toHaveBeenCalledTimes(1));
    expect(addAppListenerMock).toHaveBeenCalledWith("appStateChange", expect.any(Function));
    const appStateListener = addAppListenerMock.mock.calls[0]?.[1] as
      | ((state: { isActive: boolean }) => void)
      | undefined;
    expect(appStateListener).toBeTypeOf("function");
    setStatusBarStyleMock.mockClear();
    setStatusBarBackgroundColorMock.mockClear();

    appStateListener?.({ isActive: false });
    expect(setStatusBarStyleMock).not.toHaveBeenCalled();
    expect(setStatusBarBackgroundColorMock).not.toHaveBeenCalled();

    appStateListener?.({ isActive: true });

    await vi.waitFor(() => {
      expect(setStatusBarStyleMock).toHaveBeenCalledWith({ style: "LIGHT" });
      expect(setStatusBarBackgroundColorMock).toHaveBeenCalledWith({ color: "#ffffff" });
    });
  });

  it("removes an asynchronously installed app listener after unmount", async () => {
    let resolveListener: ((listener: { remove: () => Promise<void> }) => void) | undefined;
    addAppListenerMock.mockReturnValue(
      new Promise<{ remove: () => Promise<void> }>((resolve) => {
        resolveListener = resolve;
      }),
    );
    await renderTheme("light");
    await vi.waitFor(() => expect(addAppListenerMock).toHaveBeenCalledTimes(1));

    await act(async () => root.render(null));
    resolveListener?.({ remove: removeAppListenerMock });

    await vi.waitFor(() => expect(removeAppListenerMock).toHaveBeenCalledTimes(1));
    setStatusBarStyleMock.mockClear();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    expect(setStatusBarStyleMock).not.toHaveBeenCalled();
  });

  it("does not load the native status-bar bridge on the web", async () => {
    isNativePlatformMock.mockReturnValue(false);
    window.localStorage.setItem("instafy.themeMode", "light");

    await act(async () => {
      root.render(<ThemeProvider>{null}</ThemeProvider>);
    });

    expect(setStatusBarStyleMock).not.toHaveBeenCalled();
    expect(setStatusBarBackgroundColorMock).not.toHaveBeenCalled();
    expect(addAppListenerMock).not.toHaveBeenCalled();
  });
});
