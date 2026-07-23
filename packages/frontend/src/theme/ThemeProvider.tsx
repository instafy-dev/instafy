import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const THEME_STORAGE_KEY = "instafy.themeMode";
const NATIVE_STATUS_BAR_BACKGROUND = {
  light: "#ffffff",
  dark: "#181818",
} satisfies Record<ResolvedTheme, string>;

interface ThemeContextValue {
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredThemeMode(): ThemeMode {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return "system";
    }
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) {
      return "system";
    }
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "light" || trimmed === "dark" || trimmed === "system") {
      return trimmed;
    }
    return "system";
  } catch {
    return "system";
  }
}

function writeStoredThemeMode(mode: ThemeMode) {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    if (mode === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // ignore storage failures
  }
}

function resolveSystemTheme(): ResolvedTheme {
  try {
    if (typeof window === "undefined" || !window.matchMedia) {
      return "light";
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "dark") {
    return "dark";
  }
  if (mode === "light") {
    return "light";
  }
  return resolveSystemTheme();
}

function applyResolvedTheme(theme: ResolvedTheme) {
  try {
    if (typeof document === "undefined") {
      return;
    }
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    if (Capacitor.isNativePlatform()) {
      void import("@capacitor/status-bar")
        .then(({ StatusBar, Style }) =>
          Promise.all([
            StatusBar.setStyle({ style: theme === "dark" ? Style.Dark : Style.Light }),
            StatusBar.setBackgroundColor({ color: NATIVE_STATUS_BAR_BACKGROUND[theme] }),
          ]),
        )
        .catch(() => undefined);
    }
  } catch {
    // ignore DOM failures
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => readStoredThemeMode());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(themeMode));
  const resolvedThemeRef = useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
  }, []);

  useEffect(() => {
    const nextResolved = resolveTheme(themeMode);
    setResolvedTheme(nextResolved);
    applyResolvedTheme(nextResolved);
    writeStoredThemeMode(themeMode);

    if (themeMode !== "system") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const updated = resolveSystemTheme();
      setResolvedTheme(updated);
      applyResolvedTheme(updated);
    };

    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [themeMode]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || typeof window === "undefined") {
      return;
    }

    let disposed = false;
    let frameId: number | null = null;
    let appStateListener: { remove: () => Promise<void> } | undefined;
    const reapplyNativeTheme = () => {
      frameId = null;
      if (!disposed) {
        applyResolvedTheme(resolvedThemeRef.current);
      }
    };
    const scheduleNativeThemeReapply = () => {
      if (disposed || frameId !== null) {
        return;
      }
      if (typeof window.requestAnimationFrame === "function") {
        frameId = window.requestAnimationFrame(reapplyNativeTheme);
      } else {
        reapplyNativeTheme();
      }
    };

    // iOS reapplies static StatusBar config whenever the Capacitor view
    // reappears. Its WebView then regains focus, so restore the live theme.
    window.addEventListener("focus", scheduleNativeThemeReapply);
    // Android resets its core system-bar appearance during configuration
    // changes; the following WebView resize occurs after that reset.
    window.addEventListener("resize", scheduleNativeThemeReapply);
    void import("@capacitor/app")
      .then(({ App }) =>
        App.addListener("appStateChange", ({ isActive }) => {
          if (isActive) {
            scheduleNativeThemeReapply();
          }
        }),
      )
      .then((listener) => {
        if (disposed) {
          void listener.remove();
          return;
        }
        appStateListener = listener;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      window.removeEventListener("focus", scheduleNativeThemeReapply);
      window.removeEventListener("resize", scheduleNativeThemeReapply);
      if (frameId !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frameId);
      }
      void appStateListener?.remove();
    };
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeMode,
      resolvedTheme,
      setThemeMode,
    }),
    [resolvedTheme, setThemeMode, themeMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
