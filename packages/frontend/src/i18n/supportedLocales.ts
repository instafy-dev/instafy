export const SUPPORTED_UI_LOCALES = ["en", "es", "fr", "de", "sv"] as const;

export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

export const UI_LOCALE_LABELS: Record<UiLocale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  sv: "Svenska",
};

export const UI_LOCALE_TAGS: Record<UiLocale, string> = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  sv: "sv-SE",
};

export function isSupportedUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && (SUPPORTED_UI_LOCALES as readonly string[]).includes(value);
}

export function normalizeLocaleTag(tag: string | null | undefined): UiLocale | null {
  if (typeof tag !== "string") {
    return null;
  }
  const trimmed = tag.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase().replace(/_/g, "-");
  const base = normalized.split("-")[0] ?? "";

  if (base === "en") return "en";
  if (base === "es") return "es";
  if (base === "fr") return "fr";
  if (base === "de") return "de";
  if (base === "sv") return "sv";
  return null;
}

export function formatLocaleTag(locale: UiLocale): string {
  return UI_LOCALE_TAGS[locale];
}

export function resolveBestUiLocaleFromNavigator(
  navigatorLike: { languages?: readonly string[]; language?: string } | null | undefined,
): UiLocale | null {
  if (!navigatorLike) {
    return null;
  }

  const candidates = Array.isArray(navigatorLike.languages)
    ? navigatorLike.languages
    : typeof navigatorLike.language === "string"
      ? [navigatorLike.language]
      : [];

  for (const entry of candidates) {
    const resolved = normalizeLocaleTag(entry);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

