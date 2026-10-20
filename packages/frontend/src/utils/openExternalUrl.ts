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

/** A new tab opened before its address is known; see {@link reserveExternalWindow}. */
export type ReservedExternalWindow = {
  /** No tab could be opened (the browser blocked it): nothing should be fetched for it. */
  blocked: boolean;
  /** Shows the address in the reserved tab. False when it could not (the tab was closed, or the address is not http). */
  open: (value: string) => Promise<boolean>;
  /** Closes the reserved tab when there is nothing to show in it. */
  cancel: () => void;
};

/**
 * For an address that is only known after an await. Browsers (Safari above
 * all) only let a page open a tab while handling the person's press, so call
 * this synchronously in the press handler, then `open` the address once it
 * is known, or `cancel`. Native shells open the address with the system
 * browser instead, which needs no press.
 */
export function reserveExternalWindow(): ReservedExternalWindow {
  if (Capacitor.isNativePlatform() || typeof window === "undefined") {
    return { blocked: false, open: openExternalUrl, cancel: () => undefined };
  }
  let reserved: Window | null = null;
  try {
    reserved = window.open("about:blank", "_blank");
    if (reserved) reserved.opener = null;
  } catch {
    // A blocked or hardened popup: reported as blocked below, or still usable.
  }
  const cancel = () => {
    try { reserved?.close(); } catch { /* already gone */ }
  };
  return {
    blocked: !reserved,
    cancel,
    open: async (value) => {
      const url = normalizeExternalUrl(value);
      if (!url || !reserved || reserved.closed) { cancel(); return false; }
      try {
        reserved.location.replace(url);
        return true;
      } catch {
        cancel();
        return false;
      }
    },
  };
}
