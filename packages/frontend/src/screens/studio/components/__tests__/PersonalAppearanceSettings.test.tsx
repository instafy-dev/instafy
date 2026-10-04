// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../../../theme/ThemeProvider";
import { PersonalAppearanceSettings } from "../PersonalAppearanceSettings";

describe("Personal appearance", () => {
  let root: Root;
  let container: HTMLDivElement;
  let systemDark: boolean;
  const systemListeners = new Set<() => void>();

  function Harness() {
    return <ThemeProvider>
      <PersonalAppearanceSettings />
    </ThemeProvider>;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    systemDark = false;
    systemListeners.clear();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      get matches() { return query === "(prefers-color-scheme: dark)" && systemDark; },
      media: query,
      addEventListener: (_type: string, listener: () => void) => { if (query === "(prefers-color-scheme: dark)") systemListeners.add(listener); },
      removeEventListener: (_type: string, listener: () => void) => systemListeners.delete(listener),
    })));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const themeButton = (mode: string) => container.querySelector<HTMLButtonElement>(`[data-testid="profile-preference-theme-${mode}"]`)!;

  it("applies and persists theme changes immediately through the existing ThemeProvider", async () => {
    await act(async () => root.render(<Harness />));
    expect(themeButton("system").getAttribute("aria-pressed")).toBe("true");
    await act(async () => themeButton("dark").click());
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem("instafy.themeMode")).toBe("dark");
    expect(themeButton("dark").getAttribute("aria-pressed")).toBe("true");
    await act(async () => themeButton("light").click());
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem("instafy.themeMode")).toBe("light");
  });

  it("shows an existing saved preference and returns to following System without another save action", async () => {
    window.localStorage.setItem("instafy.themeMode", "dark");
    await act(async () => root.render(<Harness />));
    expect(themeButton("dark").getAttribute("aria-pressed")).toBe("true");
    await act(async () => themeButton("system").click());
    expect(window.localStorage.getItem("instafy.themeMode")).toBeNull();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    await act(async () => {
      systemDark = true;
      systemListeners.forEach(listener => listener());
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(themeButton("system").getAttribute("aria-pressed")).toBe("true");
  });

  it("holds only the theme choice, with no checkbox", async () => {
    await act(async () => root.render(<Harness />));
    expect(container.querySelector('[data-testid="personal-appearance-settings"] input[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toMatch(/auto-save/i);
  });
});
