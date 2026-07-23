import { Capacitor } from "@capacitor/core";

function normalizeExternalUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export async function openExternalUrl(value: string): Promise<boolean> {
  const url = normalizeExternalUrl(value);
  if (!url) {
    return false;
  }

  if (Capacitor.isNativePlatform()) {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url });
      return true;
    } catch {
      // Older native shells may not include the Browser plugin. Fall through to
      // the normal browser behavior so the action still has a chance to work.
    }
  }

  if (typeof window === "undefined") {
    return false;
  }
  return Boolean(window.open(url, "_blank", "noopener,noreferrer"));
}
