// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../../../theme/ThemeProvider";
import { PersonalPreferencesSettings } from "../PersonalPreferencesSettings";

describe("Personal preferences", () => {
  let root: Root;
  let container: HTMLDivElement;
  let systemDark: boolean;
  const systemListeners = new Set<() => void>();
  const autoSaveChanged = vi.fn();

  function Harness() {
    const [autosave, setAutosave] = useState(true);
    return <ThemeProvider>
      <PersonalPreferencesSettings gitAutoSyncAfterApply={autosave} onGitAutoSyncChange={enabled => {
        autoSaveChanged(enabled);
        setAutosave(enabled);
      }} />
    </ThemeProvider>;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    autoSaveChanged.mockReset();
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
    expect(autoSaveChanged).not.toHaveBeenCalled();
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

  it("keeps autosave independent from the chosen theme and uses its existing change handler", async () => {
    await act(async () => root.render(<Harness />));
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);
    await act(async () => checkbox.click());
    expect(autoSaveChanged).toHaveBeenCalledExactlyOnceWith(false);
    expect(checkbox.checked).toBe(false);
    expect(themeButton("system").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("Auto-save assistant file changes");
    expect(container.textContent).toContain("If auto-save fails");
  });
});
