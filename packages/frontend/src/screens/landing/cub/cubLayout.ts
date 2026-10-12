// Anchors -> perch. Turns the host's anchor rects into the layout the engine
// works in: the perch size u, the perch mode (corner / header / phone) and
// body x, the collision scenes for idle, curious and reaching arms, the shift
// range, and the canvas region. Ported from the owner-approved prototype (not
// in this repo) against the CubAnchors contract instead of the prototype's DOM.
// Pure: no DOM access, so it runs in unit tests.

import { COIN_M, EB_AMP, REACH_D } from "./cubConfig";
import { camera } from "./cubCamera";
import { motionOK } from "./cubClock";
import { eyeSolve } from "./cubEyes";
import { clamp } from "./cubMath";
import { reachPlan } from "./cubReach";
import { bodyClear } from "./cubRig";
import type { Cub, Geo, KeepRect, Layout } from "./cubState";
import type { CubAnchors, CubLayoutTuning, CubRect } from "./cubTypes";

const r4 = (r: CubRect): CubRect => ({ x: r.x, y: r.y, w: r.w, h: r.h });
const fin = (r: CubRect | null | undefined): r is CubRect =>
  !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h);

/** The phone perch: the host's own word for its layout, else a host narrower than the breakpoint. */
export const isMobile = (a: CubAnchors, W: number, tuning: CubLayoutTuning): boolean => a.mobile ?? W < tuning.mobileBreakpoint;

/** The corner perch may be used: the host's word for its layout, else a host at least cornerMinWidth wide. */
export const cornerAllowed = (a: CubAnchors, W: number, tuning: CubLayoutTuning): boolean => a.corner ?? W >= tuning.cornerMinWidth;

/** Builds the engine's layout from anchors (the prototype's measure()). */
export function measureAnchors(a: CubAnchors, W: number, H: number, DPR: number, tuning: CubLayoutTuning): Layout {
  const mobile = isMobile(a, W, tuning);
  const cornerOK = cornerAllowed(a, W, tuning);
  const text = a.textLines.filter(fin).map(r4);
  const cta = fin(a.cta) ? r4(a.cta) : null;
  const chipRects = (a.chips ?? []).filter(fin).map(r4);
  const extra = (a.keepOut ?? []).filter(fin).map(r4);
  // Chrome glyphs are small and tightly packed: a 3 px margin (not the default 4).
  const chrome: KeepRect[] = (a.chrome ?? []).filter(fin).map((r) => ({ ...r4(r), m: 3 }));
  const win = r4(a.window);
  const coins: KeepRect[] = a.coins.filter(fin).map(r4);
  if (!coins.length) coins.push({ x: win.x + win.w - 40, y: win.y + 12, w: 28, h: 28 });
  const octoIdx = clamp(0, Math.round(a.octoCoin), coins.length - 1);
  const octoCoin = coins[octoIdx];
  const chips: CubRect = chipRects.length
    ? (() => {
        const x = Math.min(...chipRects.map((r) => r.x));
        const y = Math.min(...chipRects.map((r) => r.y));
        return {
          x,
          y,
          w: Math.max(...chipRects.map((r) => r.x + r.w)) - x,
          h: Math.max(...chipRects.map((r) => r.y + r.h)) - y,
        };
      })()
    : // No chips: a stand-in 140 px above the window's left end, so the phone perch gets its full size.
      { x: win.x, y: Math.max(0, win.y - 140), w: 0, h: 0 };
  const keep: CubRect[] = [...text, ...(cta ? [cta] : []), ...extra, ...chipRects];
  const coinL = Math.min(...coins.map((r) => r.x));
  const coinR = Math.max(...coins.map((r) => r.x + r.w));
  const kim = r4(a.floor);
  const poi = a.poi ?? {};
  const sig = [W, H, DPR, mobile ? "m" : "d", cornerOK ? "c" : "h", ...keep, ...chrome, win, octoCoin, kim]
    .map((r) => (typeof r === "number" || typeof r === "string" ? String(r) : [r.x, r.y, r.w, r.h].map((v) => Math.round(v)).join(",")))
    .join("|");
  return {
    W,
    H,
    mobile,
    cornerOK,
    text,
    cta,
    chipRects,
    chips,
    win,
    main: r4(a.panel),
    tcol: r4(a.transcript),
    coins,
    octoIdx,
    coinL,
    coinR,
    octoCoin,
    kim,
    ctitleRow: r4(a.titleRow),
    comp: r4(a.composer),
    mOcto: fin(poi.octoMessage) ? r4(poi.octoMessage) : null,
    you: fin(poi.own) ? r4(poi.own) : null,
    fchip: fin(poi.file) ? r4(poi.file) : null,
    h1: fin(poi.title) ? r4(poi.title) : null,
    keep,
    chrome,
    sig,
  };
}

/** The perch size in css px (the body is about 1.9u tall). */
export function perchU(L: Layout, tuning: CubLayoutTuning): number {
  if (L.mobile) {
    const m = tuning.mobileU;
    return clamp(m.min, Math.min((L.win.y - L.chips.y) / m.aboveK, (L.win.y - (L.chips.y + L.chips.h)) / m.belowK), m.max);
  }
  const d = tuning.desktopU;
  return clamp(d.min, L.W * d.k, d.max);
}

/** The collision scene: ledge, window ends, how deep front arms hang, the transcript column, every keep-out. */
export function geo(L: Layout): Geo {
  const w = L.win;
  const floorY = L.mobile ? L.ctitleRow.y + L.ctitleRow.h + 2 : L.kim.y - 6;
  const deep = Math.min(w.y + w.h * 0.6, L.comp.y - 18);
  // The transcript keep-out starts at the floor, but never above the roster
  // coins' bottom: the lent arm must reach Octo's coin even when the roster
  // sits below the phone floor (a window with a top bar above its roster).
  const coinsBottom = L.coins.reduce((m, r) => Math.max(m, r.y + r.h), -Infinity);
  const colTop = coinsBottom > w.y && coinsBottom < w.y + w.h ? Math.max(floorY, coinsBottom + 2) : floorY;
  const col = { x: L.tcol.x - 6, y: colTop, w: L.tcol.w + 12, h: w.y + w.h - colTop };
  // On a phone the window's top bar sits right under the ledge: its glyphs and
  // title are marked bar, so crew ink can still straddle the ledge above them
  // (inkClearS). Marked here, by layout, not looked up by identity later: the
  // anchors are measured afresh on every frame's layout check.
  const bar = (r: KeepRect): KeepRect => (L.mobile ? { ...r, bar: true } : r);
  return {
    edgeY: w.y,
    wx0: w.x,
    wx1: w.x + w.w,
    wy1: w.y + w.h,
    floorY,
    deep,
    col,
    xMin: 16,
    xMax: L.W - 16,
    rects: [...L.keep, ...L.coins, ...L.chrome.map(bar), bar(L.ctitleRow), L.kim, col],
  };
}

/** Chooses the perch mode and the body's x: the window's corner if it is clear, else along the header, or the phone perch. */
export function placeBody(c: Cub): number {
  const L = c.L!;
  const OC = c.OC;
  const u = OC.u;
  const w = L.win;
  const cc = L.octoCoin.x + L.octoCoin.w / 2;
  const near = cc - REACH_D * 2.1 * u - 0.27 * u;
  if (L.mobile) {
    OC.mode = "mobile";
    const cl = L.coins.length ? L.coins[0].x : w.x + w.w * 0.6;
    const chR = L.chips.x + L.chips.w;
    const lo = Math.max(w.x + 2.2 * u, chR + 1.35 * u + 6);
    const hi = w.x + w.w - 3 * u;
    return clamp(lo, Math.max(near, Math.min((Math.max(chR, w.x + 2.2 * u) + cl) / 2 + 0.2 * u, cl - 1.4 * u)), Math.max(lo, hi));
  }
  const rs = L.keep;
  const wx1 = w.x + w.w;
  // Coins deep under the ledge (cornerCoinDepth) do not push Cub off the corner.
  const depth = c.o.tuning.cornerCoinDepth;
  const ledgeCoins = depth == null ? L.coins : L.coins.filter((r) => r.y - w.y <= depth * u);
  const coinR = ledgeCoins.length ? Math.max(...ledgeCoins.map((r) => r.x + r.w)) : -Infinity;
  const bc = Math.max(coinR + 0.55 * u, wx1 - 1.8 * u);
  if (L.cornerOK && bc <= wx1 - 1.3 * u && bodyClear(c, bc, rs)) {
    OC.mode = "corner";
    return bc;
  }
  OC.mode = "header";
  const tr = L.ctitleRow;
  const x0 = Math.max(w.x + 3 * u, tr.x + tr.w + 1.1 * u);
  const x1 = Math.min(wx1 - 3 * u, Math.max(L.coinL - 1.0 * u, near));
  for (let bx = x1; bx >= x0; bx -= 4) if (bodyClear(c, bx, rs)) return bx;
  return Math.max(x0, x1);
}

/** The region (device px, host-relative) the WebGL canvas covers: only Cub's reach, never the whole hero. */
export function canvasRect(c: Cub): { x: number; y: number; w: number; h: number } {
  const L = c.L!;
  const G = c.G!;
  const { W, H, DPR } = c.cam;
  const u = c.OC.u;
  const w = L.win;
  let x0: number;
  let x1: number;
  let y0: number;
  let y1: number;
  if (L.mobile) {
    x0 = 0;
    x1 = W;
    y0 = Math.min(L.chips.y, w.y - 5 * u) - 10;
    y1 = Math.max(L.octoCoin.y + L.octoCoin.h, L.ctitleRow.y + L.ctitleRow.h) + 30;
  } else {
    x0 = Math.min(c.OC.bx - 5.4 * u, L.octoCoin.x - 30);
    x1 = W;
    y0 = w.y - 4.9 * u;
    // When the transcript keep-out spans everything right of x0 to the window's
    // end, no arm hangs past the floor, so the canvas need not reach "deep" (a
    // tall window would otherwise get a canvas several hundred px too tall).
    const colCovers = G.col.x <= x0 && G.col.x + G.col.w >= Math.min(W, w.x + w.w);
    const deep = colCovers ? Math.min(G.deep, G.floorY + 0.25 * u) : G.deep;
    y1 = Math.max(deep + 12, L.octoCoin.y + L.octoCoin.h + 30, w.y + 2.6 * u);
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  y1 = Math.min(H, y1);
  const cx = Math.floor(x0 * DPR);
  const cy = Math.floor(y0 * DPR);
  const cw = Math.max(1, Math.ceil(x1 * DPR) - cx);
  const ch = Math.max(1, Math.ceil(y1 * DPR) - cy);
  return { x: cx, y: cy, w: cw, h: ch };
}

/**
 * Whether any of Cub can be on screen, with the host's top left at (left,
 * top) in a vw x vh viewport (css px): his last drawn box, or the perch the
 * current layout puts him on (after a relayout the body trails the perch for
 * a moment, and a layout not drawn yet has no box at all). The frame loop
 * stops when this is false, so it errs towards true: a layout that has not
 * been drawn can never hide him.
 */
export function cubOnScreen(c: Cub, left: number, top: number, vw: number, vh: number): boolean {
  const BB = c.BB;
  const G = c.G;
  if (!BB || !G || !c.L) return true;
  const hit = (x0: number, y0: number, x1: number, y1: number) => top + y1 > 0 && top + y0 < vh && left + x1 > 0 && left + x0 < vw;
  const u = c.OC.u;
  const bx = c.OC.bx;
  return hit(BB[0], BB[1], BB[2], BB[3]) || hit(bx - 2 * u, G.edgeY - 2.5 * u, bx + 2 * u, G.edgeY + u);
}

/** The device pixel ratio the engine renders at. */
export const capDpr = (c: Cub, mobile: boolean, deviceDpr: number): number =>
  Math.min(deviceDpr || 1, mobile ? c.o.dprCap.mobile : c.o.dprCap.desktop);

/**
 * Lays Cub out against the anchors (the CPU half of the prototype's layout()).
 * Always refreshes the anchors; the perch itself is recomputed only when the
 * layout signature changed (or force). Returns true when the perch changed.
 */
export function applyLayout(c: Cub, anchors: CubAnchors, W: number, H: number, deviceDpr: number, force: boolean): boolean {
  W = Math.max(1, Math.round(W));
  H = Math.max(1, Math.round(H));
  const cam = c.cam;
  const DPR = capDpr(c, isMobile(anchors, W, c.o.tuning), deviceDpr);
  const L = measureAnchors(anchors, W, H, DPR, c.o.tuning);
  c.L = L;
  if (!force && L.sig === c.lastSig && c.built) return false;
  cam.W = W;
  cam.H = H;
  cam.DPR = DPR;
  cam.WV = Math.round(W * DPR);
  cam.HV = Math.round(H * DPR);
  camera(cam);
  c.lastSig = L.sig;
  const OC = c.OC;
  const oldBx = OC.bx;
  const oldMode = OC.mode;
  const oldU = OC.u;
  OC.u = perchU(L, c.o.tuning);
  let G = geo(L);
  c.G = G;
  OC.roles = null;
  // Without eyes the eye bumps flatten (as in the prototype).
  OC.eb = c.o.eyes ? EB_AMP : 0.65 * EB_AMP;
  OC.psi0 = L.mobile ? -0.15 : -0.3;
  OC.bx = placeBody(c);
  OC.reachSh = 0;
  if (OC.mode === "header") {
    OC.psi0 = -0.16;
    OC.bx = placeBody(c);
  }
  // Keep the body where it was on a small relayout: the SHIFT spring eases it
  // over. The lag is capped at the same 0.6 u: a drag-resize lays out every
  // frame, faster than the spring follows, and an uncapped lag left the body
  // drawn off the page. Any other relayout seats him on the new perch.
  const lag = 0.6 * OC.u;
  if (
    c.started &&
    c.built &&
    !force &&
    OC.mode === oldMode &&
    Math.abs(OC.u - oldU) < 0.08 * oldU &&
    Math.abs(OC.bx - oldBx) < lag &&
    motionOK(c)
  ) {
    c.SHIFT.x = clamp(-lag, c.SHIFT.x + oldBx - OC.bx, lag);
    c.SHIFT.v = 0;
  } else {
    c.SHIFT.x = 0;
    c.SHIFT.v = 0;
  }
  // The box drawn for the old layout says nothing about the new one.
  c.BB = null;
  if (OC.mode === "corner") {
    const coins = new Set<KeepRect>(L.coins);
    G = { ...G, rects: G.rects.map((r) => (coins.has(r) ? { ...r, m: COIN_M } : r)) };
    c.G = G;
  }
  c.Sidle = G;
  OC.Scur = { ...G, xMin: 40, xMax: W - 40 };
  OC.reachSh = reachPlan(c);
  eyeSolve(c);
  {
    const co = L.octoCoin;
    const cx = co.x + co.w / 2;
    const cy = co.y + co.h / 2;
    const pr = (OC.prReach = { x: cx - 0.58 * co.w, y: cy - 0.58 * co.h, w: 1.16 * co.w, h: 1.16 * co.h, m: 1.5 });
    // The reach route itself threads the window chrome (cubReach hookRx); the
    // morph toward it does not collide with the glyphs, or an arm passing a
    // glyph's corner on its way down crumples against it for a frame or two.
    OC.Sreach = {
      ...G,
      rects: [...L.keep, ...L.coins.map((r, i) => (i === L.octoIdx ? pr : r)), L.ctitleRow, L.kim, G.col],
    };
  }
  if (OC.mode === "corner") {
    OC.shMin = -0.75 * OC.u;
    OC.shMax = 0;
  } else {
    OC.shMin = -Math.min(0.7 * OC.u, Math.max(0, OC.bx - (L.mobile ? L.chips.x + L.chips.w + 1.2 * OC.u : G.wx0 + 3 * OC.u)));
    OC.shMax = Math.min(0.7 * OC.u, Math.max(0, G.wx1 - 2.2 * OC.u - OC.bx));
  }
  c.CVR = canvasRect(c);
  return true;
}
