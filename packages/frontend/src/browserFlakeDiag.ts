// DIAGNOSTIC ONLY (branch diag/shared-studio-white-frame): never merged.
//
// Records an ordinal trace of the Shared Browser view's decisions in
// `window.__instafyBrowserDiag`, which the Studio CI journey prints when its
// canvas stays white. Ids become ordinals (P1, C1, R1...) and URLs become
// kinds (blank, fixture, ...), so no id, URL or grant leaves the page.

type DiagEntry = { t: number; e: string; d?: Record<string, unknown> };

const ordinals = new Map<string, string>();
const counters = new Map<string, number>();
const lastByChannel = new Map<string, string>();

/** A stable ordinal for a raw id within this page: `P1`, `P2`... */
export function diagId(kind: string, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (!value) return `${kind}-empty`;
  const key = `${kind}\u0000${value}`;
  let ordinal = ordinals.get(key);
  if (!ordinal) {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    ordinal = `${kind}${next}`;
    ordinals.set(key, ordinal);
  }
  return ordinal;
}

/** A conversation scope as an ordinal, with whether it is a new chat's local id. */
export function diagChat(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  return raw.startsWith("new-chat:") ? `new:${diagId("L", raw.slice("new-chat:".length))}` : diagId("C", raw);
}

/** What kind of address a URL is, never the URL. */
export function diagUrlKind(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "null";
  const value = raw.trim();
  if (!value) return "empty";
  if (value === "about:blank") return "blank";
  if (value.startsWith("http://studio-browser-fixture.test")) return "fixture";
  if (value.startsWith("chrome-error://")) return "chrome-error";
  if (value.startsWith("chrome://")) return "chrome";
  if (value.startsWith("about:")) return "about";
  if (value.startsWith("data:")) return "data";
  return "other";
}

/** The page id a browser socket URL asks for, as an ordinal. */
export function diagSocketPage(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return diagId("P", new URL(url).searchParams.get("pageId"));
  } catch {
    return "invalid";
  }
}

export function diag(event: string, data?: Record<string, unknown>): void {
  try {
    const w = window as unknown as { __instafyBrowserDiag?: DiagEntry[] };
    const list = (w.__instafyBrowserDiag ??= []);
    if (list.length < 8000) {
      list.push({ t: Math.round(performance.now()), e: event, ...(data ? { d: data } : {}) });
    }
  } catch {
    // Never break the app.
  }
}

/** Records only when the channel's value changed since it was last recorded. */
export function diagChanged(channel: string, data: Record<string, unknown>): void {
  let signature: string;
  try {
    signature = JSON.stringify(data);
  } catch {
    return;
  }
  if (lastByChannel.get(channel) === signature) return;
  lastByChannel.set(channel, signature);
  diag(channel, data);
}

/**
 * How a canvas looks now, sampled on a coarse grid: white, the fixture's mint
 * background, dark (text), or other. Numbers only.
 */
export function diagCanvasLook(canvas: HTMLCanvasElement): Record<string, number> | null {
  try {
    const { width, height } = canvas;
    if (width <= 0 || height <= 0) return null;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const data = context.getImageData(0, 0, width, height).data;
    let white = 0;
    let mint = 0;
    let dark = 0;
    let other = 0;
    const steps = 32;
    for (let row = 0; row < steps; row++) {
      for (let column = 0; column < steps; column++) {
        const x = Math.min(width - 1, Math.floor(((column + 0.5) * width) / steps));
        const y = Math.min(height - 1, Math.floor(((row + 0.5) * height) / steps));
        const offset = (y * width + x) * 4;
        const r = data[offset] ?? 0;
        const g = data[offset + 1] ?? 0;
        const b = data[offset + 2] ?? 0;
        if (r > 250 && g > 250 && b > 250) white++;
        else if (Math.abs(r - 236) < 10 && Math.abs(g - 253) < 10 && Math.abs(b - 245) < 10) mint++;
        else if (r < 150 || g < 150 || b < 150) dark++;
        else other++;
      }
    }
    return { w: width, h: height, white, mint, dark, other };
  } catch {
    return null;
  }
}

/** Live counters the CI journey reads at dump time (one entry per key, overwritten). */
export function diagLive(key: string, value: Record<string, unknown>): void {
  try {
    const w = window as unknown as { __instafyBrowserDiagLive?: Record<string, Record<string, unknown>> };
    const live = (w.__instafyBrowserDiagLive ??= {});
    live[key] = value;
  } catch {
    // Never break the app.
  }
}
