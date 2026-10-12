// Crew ink, part 3: the Canvas2D layer. A boop queues a burst (planned a
// frame later, never in the click's frame), the drops squirt out as a thin jet
// and fly as teardrops, land as stains in logo order, hold, then soak away.
// The layer is erased under every keep-out and under Cub's own outline, and in
// light mode it multiplies over the page so the dot grid ghosts through.
// The 2D backing store exists only while there is ink.
// Ported from the owner-approved prototype (not in this repo).

import { noticeOK } from "./cubClock";
import { clamp, eo, hh, lerp, smoother, sstep } from "./cubMath";
import {
  INK_CAP,
  INK_FADE,
  INK_GAP,
  INK_HEAD,
  INK_TS,
  inkBall,
  inkBP,
  inkBV,
  inkKeep,
  inkPlan,
  inkPlanS,
  inkSide,
  inkSiphonS,
  inkSizes,
  inkVary,
} from "./cubInkPlan";
import { inkBuildS, inkMakeS, inkShape, inkTearPoly } from "./cubInkShape";
import type { Ball, Cub, InkDrop, InkPlan, InkSet } from "./cubState";

/** Frames a boop's burst is retried when no set can be planned yet. */
const INK_RETRY_FRAMES = 5;

/** Allocates the 2D backing store only while there is ink. */
function inkAlloc(c: Cub, on: boolean): void {
  const cv = c.ink.cv;
  if (!cv) return;
  const w = on ? c.ink.R.w : 0;
  const h = on ? c.ink.R.h : 0;
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
}

/** The ink layer: the WebGL canvas's rect, reaching a little further left along the ledge on desktop. */
export function inkSize(c: Cub): void {
  const L = c.L!;
  const { CVR } = c;
  const DPR = c.cam.DPR;
  const ext = !L.mobile ? Math.max(0, Math.floor(Math.max(L.win.x + 8, c.OC.bx - 10 * c.OC.u) * DPR)) : CVR.x;
  const x0 = Math.min(CVR.x, ext);
  c.ink.R = { x: x0, y: CVR.y, w: CVR.x + CVR.w - x0, h: CVR.h };
  inkAlloc(c, c.ink.sets.length > 0);
  const cv = c.ink.cv;
  if (cv) {
    const R = c.ink.R;
    Object.assign(cv.style, { left: R.x / DPR + "px", top: R.y / DPR + "px", width: R.w / DPR + "px", height: R.h / DPR + "px" });
  }
  c.ink.dirty = !!c.ink.x2d;
}

/** Plans and makes one set; never comes back empty while any spot fits (the splat falls back to the dots' geometry). */
function inkMake(c: Cub, t: number, st: boolean, quick: boolean): InkSet | null {
  if (!c.G || !c.L || !c.NHIT) return null;
  const I = c.ink;
  const seed = Math.floor(hh(Math.floor(t * 997) + 7 + (st ? I.staticN * 7919 + (Math.floor(performance.now()) & 65535) : 0)) * 1e4);
  const vr = inkVary(st ? 0 : I.n, seed, true);
  let sd = inkSide(c);
  if (vr.flip) sd = -sd;
  Object.assign(vr, inkSizes(c, seed, I.n === 0 || st));
  let pl: InkPlan | null =
    inkPlanS(c, sd, vr) || (vr.rot || vr.sp !== 1 ? inkPlanS(c, sd, Object.assign(inkVary(0, 0), { sz: vr.sz, gj: vr.gj })) : null);
  if (!pl) {
    const q = inkPlan(c, sd, inkVary(0, 0));
    if (q) pl = { sd: q.sd, r: 1.1 * q.r, pts: q.pts, near: q.near, lv: 0 };
  }
  if (!pl) return null;
  return inkMakeS(c, t, st, quick, pl, seed);
}

/**
 * A boop's burst. Boops within INK_GAP of the last queue up (three at most);
 * planning runs on the next frame. Planned now, returns false when no set
 * could be made yet (the caller tries again on the next frames).
 */
export function inkBurst(c: Cub, t: number, quick: boolean, now: boolean): boolean {
  const I = c.ink;
  if (!now) {
    const last = I.queue.length ? I.queue[I.queue.length - 1].at : I.last;
    if (t - last < INK_GAP) {
      if (I.queue.length < 3) I.queue.push({ at: last + INK_GAP, quick });
      return true;
    }
  }
  if (!now && t - I.last < INK_GAP) return true;
  if (!now) {
    I.pend = { t, quick, f: 0 };
    I.last = t;
    return true;
  }
  // Plan as if the set on the wall had soaked: the fresh set may land in its place.
  const old = I.sets.filter((o) => o.fadeT == null);
  for (const o of old) o.fadeT = t;
  const b = inkMake(c, t, false, quick);
  if (!b) {
    for (const o of old) o.fadeT = null;
    return false;
  }
  // The set on the wall keeps its colour while the fresh drops fly and fades (150 ms) as they land.
  const land = Math.min(...b.drops.map((d) => d.t0 + d.B0.T));
  for (const o of old) {
    o.fadeD = INK_TS.fq;
    o.fadeT = !o.st && t > o.t + INK_TS.hold - 0.05 ? t : Math.max(t, land - INK_TS.fq);
  }
  while (I.sets.length >= INK_CAP) I.sets.shift();
  I.sets.push(b);
  I.last = t;
  I.n++;
  return true;
}

/** The window the ink layer lives in (its canvas's), for frames and timers; null outside a browser. */
function viewOf(c: Cub): Window | null {
  return c.ink.cv?.ownerDocument.defaultView ?? (typeof window !== "undefined" ? window : null);
}

/** Warms the splat paths once while the page is idle, so the first boop pays no first-run cost. */
export function inkWarm(c: Cub): void {
  const I = c.ink;
  cancelWarm(c);
  const run = () => {
    I.warmH = 0;
    if (c.destroyed || !c.G || !c.L || !c.NHIT || I.sets.length || I.pend) return;
    if (!I.x2d && I.cv) I.x2d = I.cv.getContext("2d");
    const vr = Object.assign(inkVary(0, 0), inkSizes(c, 1, true));
    const pl = inkPlanS(c, inkSide(c), vr);
    if (!pl) return;
    const b = inkMakeS(c, c.simClock, false, false, pl, 1);
    while (b.nb < 4) inkBuildS(c, b);
    if (typeof Path2D !== "undefined")
      for (const d of b.drops) {
        inkShape(d, 0.03);
        inkShape(d, 9);
      }
  };
  const w = viewOf(c);
  if (w && typeof w.requestIdleCallback === "function") {
    I.warmIdle = true;
    I.warmH = w.requestIdleCallback(run, { timeout: 1500 });
  } else if (w) {
    I.warmIdle = false;
    I.warmH = w.setTimeout(run, 400);
  }
}

export function cancelWarm(c: Cub): void {
  const I = c.ink;
  if (!I.warmH) return;
  const w = viewOf(c);
  if (I.warmIdle && w && typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(I.warmH);
  else w?.clearTimeout(I.warmH);
  I.warmH = 0;
}

/**
 * The page laid out again. When the ledge and Cub's perch are where they were
 * (a scenario swap changes only what is inside the window) the ink on the wall
 * stays and soaks away on its own, re-erased under the new keep-outs on every
 * draw; otherwise every set fades out quickly instead of vanishing. A burst
 * still waiting to be planned is planned on the new layout either way.
 */
export function inkRelayout(c: Cub, keep: boolean, t: number): void {
  const I = c.ink;
  if (!keep)
    for (const b of I.sets)
      if (b.fadeT == null || t < b.fadeT) {
        b.fadeT = t;
        b.fadeD = INK_TS.fq;
      }
  if (I.x2d) {
    I.dirty = true;
    inkDraw(c, t);
  }
}

/** No ink survives a motion change or a reset, not even a frozen frame of it. */
export function inkReset(c: Cub): void {
  const I = c.ink;
  const w = viewOf(c);
  w?.clearTimeout(I.staticTO);
  I.staticTO = 0;
  if (I.staticRaf) w?.cancelAnimationFrame(I.staticRaf);
  I.staticRaf = 0;
  I.staticN++;
  I.pend = null;
  I.queue.length = 0;
  I.sets.length = 0;
  c.INKG.t0 = -99;
  if (I.x2d) {
    I.dirty = true;
    inkDraw(c, c.simClock);
  }
}

/** Reduced motion or motion off: no flight; the set simply appears beside Cub for a second. */
export function inkStatic(c: Cub): void {
  const I = c.ink;
  const w = viewOf(c);
  if (!w) return;
  w.clearTimeout(I.staticTO);
  I.staticTO = 0;
  if (I.staticRaf) w.cancelAnimationFrame(I.staticRaf);
  const n = ++I.staticN;
  I.staticRaf = w.requestAnimationFrame(() => {
    I.staticRaf = 0;
    I.staticTO = w.setTimeout(() => {
      I.staticTO = 0;
      if (n !== I.staticN || c.destroyed) return;
      I.sets.length = 0;
      const b = inkMake(c, c.simClock, true, false);
      if (!b) {
        inkDraw(c, c.simClock);
        return;
      }
      I.sets.push(b);
      inkDraw(c, c.simClock);
      I.staticTO = w.setTimeout(() => {
        I.staticTO = 0;
        const k = I.sets.indexOf(b);
        if (k >= 0) {
          I.sets.splice(k, 1);
          inkDraw(c, c.simClock);
        }
      }, 1000);
    }, 0);
  });
}

/** The loop stopped with ink mid-burst: after a second, drop it rather than replaying stale ink later. */
export function inkPause(c: Cub): void {
  const I = c.ink;
  const w = viewOf(c);
  w?.clearTimeout(I.pauseTO);
  I.pauseTO = 0;
  const pending = () => !!I.pend || I.queue.length > 0 || I.sets.some((b) => !b.st);
  if (w && !c.playing() && pending())
    I.pauseTO = w.setTimeout(() => {
      I.pauseTO = 0;
      if (!c.destroyed && !c.playing() && pending()) inkReset(c);
    }, 1000);
}

/** One page-sized layer, only while a set fades (so it fades as one). */
function inkLayer(c: Cub): CanvasRenderingContext2D | null {
  const I = c.ink;
  const cv = I.cv;
  if (!cv) return null;
  const w = cv.width;
  const h = cv.height;
  if (!I.layer) I.layer = document.createElement("canvas");
  if (I.layer.width !== w || I.layer.height !== h) {
    I.layer.width = w;
    I.layer.height = h;
    I.layerX = null;
  }
  return I.layerX || (I.layerX = I.layer.getContext("2d"));
}

function inkRGB(c: Cub, h: string): number[] {
  const hit = c.ink.rgb.get(h);
  if (hit) return hit;
  const s = h.replace("#", "");
  const v = s.length === 3 ? s.split("").map((ch) => parseInt(ch + ch, 16)) : [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  c.ink.rgb.set(h, v);
  return v;
}
/** k > 0 darker, k < 0 lighter. */
const inkRgba = (col: number[], a: number, k = 0): string =>
  `rgba(${col.map((v) => Math.round(k >= 0 ? v * (1 - k) : v + (255 - v) * -k)).join(",")},${+a.toFixed(3)})`;
/** Closing on the page over the last third of the flight. */
const inkAppr = (s: number): number => 0.8 + 0.2 * smoother((s - 0.65) / 0.35);

/** A drop on the move: a small teardrop stretched along its velocity, with a tiny trailing bead while it is fast. */
function inkTear(x: CanvasRenderingContext2D, cx: number, cy: number, r: number, vx: number, vy: number, u: number, wob: number, bead: boolean): void {
  const sp = Math.hypot(vx, vy);
  const ang = Math.atan2(vy, vx);
  const k = Math.min(1, sp / (26 * u));
  const w = Math.sin(wob);
  const P = new Path2D();
  const e = 1.08 + 0.12 * k + 0.06 * w;
  const rr = r * (1 - 0.05 * w);
  const tl = rr * (1.9 + 1.3 * k);
  inkTearPoly(P, cx, cy, rr, ang + Math.PI, tl, e);
  if (bead && k > 0.35) {
    const bd = tl + rr * (1.1 + 0.8 * k);
    const br = Math.max(0.5, 0.3 * rr);
    inkTearPoly(P, cx - Math.cos(ang) * bd, cy - Math.sin(ang) * bd, br, 0, 0, 1);
  }
  x.fill(P);
}

/** A thin tapered band along the drop's own path between a0 and a1 (the jet). */
function inkBand(x: CanvasRenderingContext2D, B: Ball, a0: number, a1: number, w0: number, w1: number): void {
  if (a1 - a0 < 1e-4) return;
  const n = 8;
  const lf: number[][] = [];
  const rt: number[][] = [];
  for (let j = 0; j <= n; j++) {
    const f = j / n;
    const tt = a0 + (a1 - a0) * f;
    const p = inkBP(B, tt);
    const v = inkBV(B, tt);
    const vn = Math.hypot(v[0], v[1]) || 1;
    const w = lerp(w0, w1, f);
    const nx = -v[1] / vn;
    const ny = v[0] / vn;
    lf.push([p[0] + nx * w, p[1] + ny * w]);
    rt.push([p[0] - nx * w, p[1] - ny * w]);
  }
  x.beginPath();
  lf.forEach((q, j) => (j ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1])));
  for (let j = n; j >= 0; j--) x.lineTo(rt[j][0], rt[j][1]);
  x.closePath();
  x.fill();
  const e = inkBP(B, a0);
  x.beginPath();
  x.arc(e[0], e[1], Math.max(0.2, w0), 0, 6.2831853);
  x.fill();
}

const inkHead = (d: InkDrop, a: number): number => 0.34 * d.R * inkAppr(a / d.B!.T) * (0.6 + 0.4 * eo(a / 0.05));

/** The first ~75 ms: one connected squirt back toward the siphon that thins and pinches off from the back. */
function inkJet(x: CanvasRenderingContext2D, d: InkDrop, a: number): void {
  if (a >= INK_TS.jet) return;
  const B = d.B!;
  const rh = inkHead(d, a);
  const pin = sstep(0.03, INK_TS.jet - 0.002, a);
  const a0 = Math.max(0, a - 0.075) + (a - Math.max(0, a - 0.075)) * 0.92 * pin;
  inkBand(x, B, a0, a, 0.14 * rh * (1 - pin) + 0.06 * rh, 0.5 * rh);
}

function inkSplats(c: Cub, x: CanvasRenderingContext2D, b: InkSet, t: number): void {
  const u = c.OC.u;
  const { DPR } = c.cam;
  const I = c.ink;
  const fo = b.fadeT != null ? smoother((t - b.fadeT) / (b.fadeD || INK_TS.fade)) : 0;
  if (fo >= 1) return;
  const sk = b.st ? 0 : clamp(0, (t - (b.t + INK_TS.hold)) / INK_TS.soak, 1);
  if (sk >= 1) return;
  const alpha = (1 - smoother(sk)) * (1 - fo);
  let landed = 0;
  let gx = 0;
  let gy = 0;
  const fly: [InkDrop, number, number[]][] = [];
  const land: [InkDrop, number, number[]][] = [];
  for (const d of b.drops) {
    const a = b.st ? 9 : t - d.t0;
    if (a < 0) continue;
    if (!b.st && !d.B) {
      const sp = inkSiphonS(c, b.sd);
      d.B = inkBall(sp[0], sp[1] + d.sj, d.tx, d.ty, d.H, u, b.gk);
    }
    const base = inkRGB(c, c.theme.crew[d.i]);
    const al = b.st ? 9 : a - d.B!.T;
    if (!b.st) fly.push([d, a, base]);
    if (al < 0) continue;
    while (!d.built && b.nb < 4) inkBuildS(c, b);
    landed++;
    gx += d.tx;
    gy += d.ty;
    land.push([d, al, base]);
  }
  // Together: biggest first, so a small stain is never buried.
  if (b.tog) land.sort((p, q) => q[0].R - p[0].R || p[0].i - q[0].i);
  if (land.length) {
    const lay = alpha < 0.999 ? inkLayer(c) : null;
    const tg = lay || x;
    if (lay && I.layer) {
      lay.setTransform(1, 0, 0, 1, 0, 0);
      lay.clearRect(0, 0, I.layer.width, I.layer.height);
      lay.setTransform(DPR, 0, 0, DPR, -I.R.x, -I.R.y);
    }
    tg.globalAlpha = 1;
    for (const [d, al, base] of land) {
      tg.fillStyle = inkRgba(base, 1);
      tg.fill(inkShape(d, al));
    }
    if (lay && I.layer) {
      x.save();
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.globalAlpha = alpha;
      x.drawImage(I.layer, 0, 0);
      x.restore();
    }
  }
  // In the air, over the landed ink: the jets, then the teardrops; nothing in the air shows under the ledge line.
  if (fly.some(([d, a]) => a < d.B!.T)) {
    x.save();
    x.beginPath();
    x.rect(-1e5, -1e5, 2e5, 1e5 + c.G!.edgeY);
    x.clip();
    x.globalAlpha = 1 - fo;
    for (const [d, a, base] of fly)
      if (a < d.B!.T) {
        x.fillStyle = inkRgba(base, 1);
        inkJet(x, d, a);
      }
    for (const [d, a, base] of fly)
      if (a < d.B!.T) {
        const q = inkBP(d.B!, a);
        const v = inkBV(d.B!, a);
        x.fillStyle = inkRgba(base, 1);
        inkTear(x, q[0], q[1], inkHead(d, a), v[0], v[1], u, d.wob + a * 45, a < 0.5 * d.B!.T);
      }
    x.restore();
  }
  x.globalAlpha = 1;
  // The last drop lands: Cub looks at what he made.
  if (!b.st && !b.glanced && landed === 4 && b.fadeT == null) {
    b.glanced = true;
    if (noticeOK(c)) {
      c.INKG.t0 = t;
      c.INKG.x = gx / 4;
      c.INKG.y = gy / 4;
      c.EYE.nextFix = t;
      c.kick();
    }
  }
}

/** Draws the ink layer at sim time t (plans a queued burst, builds one crown a frame, erases keep-outs and Cub). */
export function inkDraw(c: Cub, t: number): void {
  const I = c.ink;
  const cv = I.cv;
  if (I.queue.length && !I.pend && t >= I.queue[0].at) {
    const q = I.queue.shift()!;
    I.pend = { t, quick: q.quick, f: 0 };
    I.last = t;
  }
  let planned = false;
  if (I.pend && ++I.pend.f >= 2) {
    const p = I.pend;
    I.pend = null;
    // Nothing to plan from yet (no frame of Cub drawn since a relayout, say):
    // try again on the next few frames rather than drop the boop's ink.
    if (!inkBurst(c, p.t, p.quick, true)) {
      if (p.f < INK_RETRY_FRAMES) I.pend = p;
      else if (import.meta.env.DEV) I.dropped++;
    }
    planned = true;
  }
  if (!planned)
    for (const b of I.sets)
      if (b.nb < 4 && b.fadeT == null) {
        inkBuildS(c, b);
        break;
      }
  if (!I.sets.length && !I.dirty) return;
  if (!cv) return;
  if (I.sets.length) inkAlloc(c, true);
  const x = I.x2d || (I.x2d = cv.getContext("2d"));
  if (!x) return;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, cv.width, cv.height);
  I.dirty = false;
  if (!c.G || !c.L) return;
  for (let k = I.sets.length - 1; k >= 0; k--) {
    const b = I.sets[k];
    if (!b.st && (t - b.t > b.dur || t < b.t - 0.5 || (b.fadeT != null && t - b.fadeT > INK_FADE))) I.sets.splice(k, 1);
  }
  if (!I.sets.length) {
    // At rest: no fade layer, no backing store, no blended layer.
    if (I.layer) {
      I.layer.width = I.layer.height = 0;
      I.layer = null;
      I.layerX = null;
    }
    inkAlloc(c, false);
    if (cv.style.mixBlendMode) cv.style.mixBlendMode = "";
    return;
  }
  {
    // Wet ink over the page: in light mode the dot grid ghosts through.
    const mb = !c.theme.dark ? "multiply" : "";
    if (cv.style.mixBlendMode !== mb) cv.style.mixBlendMode = mb;
  }
  I.dirty = true;
  const DPR = c.cam.DPR;
  x.setTransform(DPR, 0, 0, DPR, -I.R.x, -I.R.y);
  for (const b of I.sets) inkSplats(c, x, b, t);
  x.globalCompositeOperation = "destination-out";
  for (const r of inkKeep(c)) x.fillRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
  {
    // Cub's outline in front of the ink: head (drawn 1.15x its spine) and arms.
    const lw = (c.L.mobile ? c.o.lw * 0.92 : c.o.lw) + 0.75;
    const H = c.HIT;
    x.beginPath();
    for (let i = 0; i < c.NHIT; i++) {
      const r = i < c.NBODYH ? (H[i * 3 + 2] - 2) * INK_HEAD + lw : H[i * 3 + 2] - 3 + lw;
      if (r > 0) {
        x.moveTo(H[i * 3] + r, H[i * 3 + 1]);
        x.arc(H[i * 3], H[i * 3 + 1], r, 0, 2 * Math.PI);
      }
    }
    x.fill("nonzero");
  }
  x.globalCompositeOperation = "source-over";
}

/** Frees the ink layer's canvases and timers. */
export function inkDispose(c: Cub): void {
  const I = c.ink;
  cancelWarm(c);
  const w = viewOf(c);
  w?.clearTimeout(I.staticTO);
  w?.clearTimeout(I.pauseTO);
  if (I.staticRaf) w?.cancelAnimationFrame(I.staticRaf);
  I.staticTO = I.pauseTO = I.staticRaf = 0;
  I.sets.length = 0;
  I.queue.length = 0;
  I.pend = null;
  if (I.layer) I.layer.width = I.layer.height = 0;
  I.layer = null;
  I.layerX = null;
  I.x2d = null;
}
