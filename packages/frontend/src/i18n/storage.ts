import type { UiLocale } from "./supportedLocales";
import { isSupportedUiLocale } from "./supportedLocales";

const UI_LOCALE_STORAGE_KEY = "instafy.uiLocale";

export function readStoredUiLocale(): UiLocale | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage?.getItem(UI_LOCALE_STORAGE_KEY) ?? null;
    if (!raw) {
      return null;
    }
    const trimmed = raw.trim().toLowerCase();
    return isSupportedUiLocale(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

export function writeStoredUiLocale(locale: UiLocale) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage?.setItem(UI_LOCALE_STORAGE_KEY, locale);
  } catch {
    // ignore storage failures
  }
}

export function clearStoredUiLocale() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage?.removeItem(UI_LOCALE_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

