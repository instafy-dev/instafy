// The no-WebGL still: three alpha-only sprites per perch mode (line art for
// light, line art for dark, body coverage) recoloured with CSS masks, so the
// still follows the theme: the body is filled with paper above the ledge and
// surface below it (or, given the panel rect, surface only inside the panel,
// as the WebGL fill does), the line is the pen colour. Ported from the
// owner-approved prototype (not in this repo). The landing's sprites are captured from
// the landing itself (landingCubFallback.ts, scripts/capture-cub-fallback.mjs);
// regenerate them whenever pose or tuning changes.

import type { CubFallbackSprite, CubPerchMode, CubRect, CubTheme } from "./cubTypes";

/**
 * Layout of the approved prototype's sprites (orig/fb.json) in CSS px: size,
 * the perch size u, the body x and the ledge y inside the sprite. The
 * placement tests check fallbackPlacement() against the prototype with them.
 */
export const CUB_FALLBACK_LAYOUT: Readonly<Record<CubPerchMode, Readonly<Pick<CubFallbackSprite, "w" | "h" | "u" | "bx" | "ey">>>> = {
  corner: { w: 324.5, h: 260, u: 79.2, bx: 140.6, ey: 207.6 },
  header: { w: 181.5, h: 164.5, u: 48, bx: 89.5, ey: 130.9 },
  mobile: { w: 133, h: 121.5, u: 33, bx: 65.6, ey: 94.2 },
};

export interface CubFallbackPlacement {
  /** Host-relative CSS px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The ledge's y inside the sprite: paper above, surface below. */
  fby: number;
  /** Header and phone sprites are clipped this many px from the bottom (everything below the ledge + 7 px). */
  clipBottom: number | null;
}

/** Scales and places a sprite captured at perch size S.u onto the live perch (u, bx) over a ledge at winY. */
export function fallbackPlacement(S: Pick<CubFallbackSprite, "w" | "h" | "u" | "bx" | "ey">, mode: CubPerchMode, u: number, bx: number, winY: number): CubFallbackPlacement {
  const sc = u / S.u;
  const w = S.w * sc;
  const h = S.h * sc;
  const x = bx - S.bx * sc;
  const y = winY - S.ey * sc;
  return { x, y, w, h, fby: winY - y, clipBottom: mode !== "corner" ? Math.max(0, h - (winY - y) - 7) : null };
}

const maskStyle = (el: HTMLElement, url: string) => {
  const v = `url("${url}")`;
  el.style.setProperty("-webkit-mask-image", v);
  el.style.setProperty("mask-image", v);
  el.style.setProperty("-webkit-mask-size", "100% 100%");
  el.style.setProperty("mask-size", "100% 100%");
  el.style.setProperty("-webkit-mask-repeat", "no-repeat");
  el.style.setProperty("mask-repeat", "no-repeat");
};

/** The fallback layer: a div with three masked children, owned by the engine and appended to the host. */
export class CubFallbackLayer {
  readonly el: HTMLDivElement;
  private readonly fill: HTMLElement;
  private readonly surf: HTMLElement;
  private readonly line: HTMLElement;
  private urls = { cov: "", ink: "" };

  constructor(doc: Document, zIndex: number) {
    const el = doc.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.dataset.cubLayer = "fallback";
    Object.assign(el.style, { position: "absolute", zIndex: String(zIndex), pointerEvents: "none", display: "none" });
    const mk = () => {
      const i = doc.createElement("i");
      Object.assign(i.style, { position: "absolute", inset: "0", display: "block" });
      el.appendChild(i);
      return i;
    };
    this.fill = mk();
    this.surf = mk();
    this.line = mk();
    this.el = el;
  }

  hide(): void {
    this.el.style.display = "none";
  }

  /** panel (host px): the surface fill covers only this rect; without it, everything below the ledge. */
  show(sprite: CubFallbackSprite, place: CubFallbackPlacement, theme: CubTheme, panel?: CubRect | null): void {
    const { el, fill, surf, line } = this;
    const ink = theme.mode === "dark" && sprite.inkDark ? sprite.inkDark : sprite.ink;
    if (this.urls.cov !== sprite.cov) {
      maskStyle(fill, sprite.cov);
      maskStyle(surf, sprite.cov);
      this.urls.cov = sprite.cov;
    }
    if (this.urls.ink !== ink) {
      maskStyle(line, ink);
      this.urls.ink = ink;
    }
    if (panel) {
      fill.style.background = theme.paper;
      surf.style.display = "block";
      surf.style.background = theme.surface;
      // The panel in sprite-local px, as clip insets.
      const cl = (v: number, max: number) => Math.min(max, Math.max(0, v));
      const top = cl(panel.y - place.y, place.h);
      const left = cl(panel.x - place.x, place.w);
      const right = cl(place.x + place.w - (panel.x + panel.w), place.w);
      const bottom = cl(place.y + place.h - (panel.y + panel.h), place.h);
      surf.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`;
    } else {
      fill.style.background = `linear-gradient(to bottom, ${theme.paper} ${place.fby}px, ${theme.surface} ${place.fby}px)`;
      surf.style.display = "none";
    }
    line.style.background = theme.pen;
    Object.assign(el.style, {
      display: "block",
      left: place.x + "px",
      top: place.y + "px",
      width: place.w + "px",
      height: place.h + "px",
      clipPath: place.clipBottom != null ? `inset(0 0 ${place.clipBottom}px 0)` : "",
    });
  }

  destroy(): void {
    this.el.remove();
  }
}
