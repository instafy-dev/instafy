// Where Cub looks and why: attention pulses (pointer, camera, ink), the
// scripted gaze of the turn, the idle wander, and the body beats (hello and
// done jigs, boop smile, wave). Ported from the owner-approved prototype (not
// in this repo).

import { JIG_BOOP, JIG_HELLO, WAVE0 } from "./cubConfig";
import { demoAt, fine, isStill, motionOK, noticeOK } from "./cubClock";
import { nearScripted } from "./cubEyes";
import { clamp, fbm, hh, keyAt, smoother, sstep, type V3 } from "./cubMath";
import type { Beats, Cub } from "./cubState";
import type { CubPoiName } from "./cubTimeline";
import type { CubRect } from "./cubTypes";

export const attEnv = (x: number): number =>
  x < 0 || x > 3.3 ? 0 : x < 0.4 ? smoother(x / 0.4) : x < 1.75 ? 1 : 1 - smoother((x - 1.75) / 1.55);
export const doneEnv = (x: number): number =>
  x < 0 || x > 1.5 ? 0 : x < 0.3 ? smoother(x / 0.3) : x < 1 ? 1 : 1 - smoother((x - 1) / 0.5);
export const helloEnv = (x: number): number =>
  x < 0 || x > 2.6 ? 0 : x < 0.4 ? smoother(x / 0.4) : x < 2.1 ? 1 : 1 - smoother((x - 2.1) / 0.5);

interface AttPart {
  e: number;
  cam: boolean;
  x: number;
  y: number;
}

export function attParts(c: Cub, t: number): AttPart[] {
  const { ATT, PT, INKG, ATTP } = c;
  const tl = c.o.timeline;
  const P: AttPart[] = [];
  const live = motionOK(c);
  if (live || isStill(c)) P.push({ e: helloEnv(t - tl.hello.t - c.helloShift), cam: true, x: 0, y: 0 });
  if (live && ATT.t0 > -90) {
    const pt = ATT.kind === "pt" && PT.in;
    P.push({ e: attEnv(t - ATT.t0) * ATT.amp, cam: ATT.kind === "cam", x: pt ? PT.x : ATT.x, y: pt ? PT.y : ATT.y });
  }
  if (live && t - INKG.t0 >= 0 && t - INKG.t0 < INKG.d + 0.4) {
    const x = t - INKG.t0;
    P.push({ e: 0.75 * smoother(x / 0.15) * (1 - smoother((x - INKG.d) / 0.4)), cam: false, x: INKG.x, y: INKG.y });
  }
  if (live && t - ATTP.t1 < 0.5)
    P.push({ e: ATTP.e0 * (1 - smoother((t - ATTP.t1) / 0.45)), cam: ATTP.cam, x: ATTP.x, y: ATTP.y });
  const d = demoAt(c);
  if (d.live) P.push({ e: doneEnv(d.td - tl.done.t), cam: true, x: 0, y: 0 });
  return P;
}

export function attNow(c: Cub, t: number): AttPart {
  let e = 0;
  let cam = false;
  let x = 0;
  let y = 0;
  for (const q of attParts(c, t))
    if (q.e > e) {
      e = q.e;
      cam = q.cam;
      x = q.x;
      y = q.y;
    }
  return { e, cam, x, y };
}

/** The head turn (yaw, roll) the attention parts ask for. */
export function attTurn(c: Cub, t: number): [number, number] {
  const OC = c.OC;
  let w = 0;
  let ps = 0;
  let rl = 0;
  c.ATTP.camE = 0;
  for (const q of attParts(c, t)) {
    if (q.e <= 0) continue;
    let p: number;
    let r: number;
    if (q.cam) c.ATTP.camE = Math.max(c.ATTP.camE, q.e);
    if (q.cam) {
      p = OC.psiCam - OC.psi0;
      r = 0.07;
    } else {
      const dx = q.x - c.HEADC[0];
      p = 0.2 * clamp(-1, dx / 380, 1);
      r = -0.12 * clamp(-1, dx / 380, 1);
    }
    w += q.e;
    ps += q.e * p;
    rl += q.e * r;
  }
  return w > 0 ? [ps / w, rl / w] : [0, 0];
}

/** Starts an attention pulse: at the camera ("cam"), the pointer ("pt") or a fixed spot. */
export function pulse(c: Cub, kind: "cam" | "pt" | "fixed", x: number, y: number, amp: number): void {
  const { ATT, ATTP, PT, EYE } = c;
  const t = c.simClock;
  if (t - ATT.t0 < 1.2 && ATT.amp >= amp) return;
  if (ATT.t0 > -90) {
    const e = attEnv(t - ATT.t0) * ATT.amp;
    if (e > 0.01)
      Object.assign(ATTP, {
        e0: e,
        t1: t,
        cam: ATT.kind === "cam",
        x: ATT.kind === "pt" && PT.in ? PT.x : ATT.x,
        y: ATT.kind === "pt" && PT.in ? PT.y : ATT.y,
      });
  }
  ATT.t0 = t;
  ATT.kind = kind;
  ATT.x = x;
  ATT.y = y;
  ATT.amp = amp;
  if (t - EYE.blinkT > 1.2 && !nearScripted(c, t)) EYE.blinkT = t + 0.05;
  c.kick();
}

/** The camera, as a gaze target (third component 1). */
export const CAM: V3 = [0, 0, 1];

const rc = (r: CubRect | null | undefined, fx?: number, fy?: number): V3 | null =>
  r ? [r.x + r.w * (fx == null ? 0.5 : fx), r.y + r.h * (fy == null ? 0.5 : fy), 0] : null;

export function poiXY(c: Cub, nm: CubPoiName, f?: number): V3 | null {
  const L = c.L;
  if (!L) return null;
  switch (nm) {
    case "opener":
      return rc(L.kim, f, 0.6);
    case "composer":
      // A composer below the fold is not something the visitor sees him look
      // at: he watches where the prompt will land instead.
      if (L.comp.y + 0.5 * L.comp.h > c.viewY1 - 8) return L.you ? rc(L.you, f, 0.5) : rc(L.kim, f, 0.6);
      return rc(L.comp, f, 0.5);
    case "own":
      return rc(L.you, f, 0.5);
    case "octoMessage":
      return rc(L.mOcto, f, 0.35);
    case "file":
      return rc(L.fchip, 0.3, 0.5);
    case "coin":
      return rc(L.octoCoin);
    case "title":
      return rc(L.h1, f, 0.5);
    case "chips":
      return L.chipRects.length ? rc(L.chips, f, 0.5) : null;
    case "roster":
      return rc({ x: L.coinL, y: L.coins[0].y, w: L.coinR - L.coinL, h: L.coins[0].h }, f, 0.5);
    case "camera":
      return CAM;
  }
  return null;
}

/** The turn's scripted gaze at td (CubTimeline.gaze); null once the script is over. */
export function scriptGaze(c: Cub, td: number): V3 | null {
  const tl = c.o.timeline;
  for (const g of tl.gaze) {
    if (td >= g.until) continue;
    if (g.poi === "camera") return CAM;
    const co = g.coin;
    if (co && (co.windows.some(([a, b]) => td >= a && td < b) || tl.taps.some((s) => Math.abs(td - s) < co.nearTaps)))
      return poiXY(c, "coin");
    if (g.scan) {
      const k = Math.floor((td - g.scan.from) / g.scan.period);
      return poiXY(c, g.poi, g.scan.fx[0] + (g.scan.fx[1] - g.scan.fx[0]) * hh(k * 7 + 3));
    }
    const f = g.fx ? g.fx[0] + (g.fx[1] - g.fx[0]) * (g.ramp ? sstep(g.ramp[0], g.ramp[1], td) : 0) : undefined;
    return poiXY(c, g.poi, f);
  }
  return null;
}

const WANDER: readonly (CubPoiName | "sky")[] = ["octoMessage", "roster", "composer", "title", "octoMessage", "chips", "coin", "sky", "opener"];

export function wanderGaze(c: Cub, t: number): V3 | null {
  const k = Math.floor((t + 2.3 * fbm(t * 0.06, 63)) / 4.3);
  if (hh(k * 97 + 11) < 0.07) return CAM;
  const nm = WANDER[Math.floor(hh(k * 41 + 9) * WANDER.length)];
  if (nm === "sky") return [c.EYEG[0].x - 60 - 80 * hh(k * 3 + 1), c.EYEG[0].y - 140, 0];
  return poiXY(c, nm, 0.2 + 0.6 * hh(k * 13 + 5));
}

/** Whether Cub is attending to a nearby, recently moving fine pointer. */
export function attending(c: Cub, t: number): boolean {
  const { PT, CUR, LOOK, EYEG } = c;
  return (
    noticeOK(c) &&
    fine(c) &&
    PT.in &&
    !PT.text &&
    !PT.ctl &&
    (t - PT.moveT < 2.4 || CUR.engaged || LOOK.on) &&
    Math.hypot(PT.x - EYEG[0].x, PT.y - EYEG[0].y) < 680
  );
}

export function attPsiPt(c: Cub, t: number): number {
  let w = 0;
  let ps = 0;
  let e = 0;
  for (const q of attParts(c, t)) {
    if (q.e <= 0) continue;
    w += q.e;
    e = Math.max(e, q.e);
    if (!q.cam) ps += q.e * 0.2 * clamp(-1, (q.x - c.HEADC[0]) / 380, 1);
  }
  return w > 0 ? (e * ps) / w : 0;
}

/** The gaze target right now, by priority: fresh ink, a touch, a boop, attention, the pointer, the script, the wander. */
export function gazeWant(c: Cub, t: number): V3 {
  const { INKG, TOUCHG, BOOP, PT } = c;
  if (motionOK(c)) {
    if (t - INKG.t0 >= 0 && t - INKG.t0 < INKG.d) return [INKG.x, INKG.y, 0];
    if (t - TOUCHG.t0 < 1.7) return [TOUCHG.x, TOUCHG.y, 0];
    if (t - BOOP.t0 > 0.4 && t - BOOP.t0 < 1.1) return CAM;
  }
  const a = attNow(c, t);
  if (a.e > 0.15) return a.cam ? CAM : [a.x, a.y, 0];
  if (motionOK(c) && attending(c, t)) return [PT.x, PT.y, 0];
  const d = demoAt(c);
  if (d.live) {
    const g = scriptGaze(c, d.td);
    if (g) return g;
  }
  return wanderGaze(c, t) || CAM;
}

function waveAt(x: number): { wave: number; wv: number } {
  const e = sstep(WAVE0, WAVE0 + 0.22, x) * (1 - sstep(WAVE0 + 1.25, WAVE0 + 1.6, x));
  const y = x - WAVE0 - 0.12;
  return { wave: e, wv: y < 0 ? 0 : Math.sin((2 * Math.PI * y) / 0.36) * Math.exp(-y / 0.75) * sstep(0, 0.06, y) };
}

/** Body beats: the hello jig and wave, the done jig and smile, the tap and boop jigs. */
export function beats(c: Cub, t: number): Beats {
  const tl = c.o.timeline;
  const live = motionOK(c);
  const sim = live || isStill(c);
  const d = demoAt(c);
  let jig = 0;
  let smile = 0;
  let wig = 0;
  let wave = 0;
  let wv = 0;
  if (sim) {
    const x = t - tl.hello.t - c.helloShift;
    jig += keyAt(JIG_HELLO, x);
    smile = Math.max(smile, sstep(0.26, 0.4, x) * (1 - sstep(tl.hello.out + 0.3 - tl.hello.t, tl.hello.out + 0.65 - tl.hello.t, x)));
    const Wv = waveAt(x);
    wave = Wv.wave;
    wv = Wv.wv;
  }
  if (d.live) {
    const D = tl.done;
    const x = d.td - D.t;
    jig += 0.75 * keyAt(JIG_HELLO, x - 0.05);
    smile = Math.max(
      smile,
      sstep(D.blinkIn - D.t, D.blinkIn - D.t + 0.3, x) * (1 - sstep(D.softBlink + 0.45 - D.t, D.softBlink + 0.8 - D.t, x)),
    );
  }
  if (live && c.TAP.t0 > -90) jig += 0.85 * keyAt(JIG_HELLO, t - c.TAP.t0 - 0.2);
  if (live && c.BOOP.t0 > -90) {
    const x = t - c.BOOP.t0;
    jig += keyAt(JIG_BOOP, x);
    smile = Math.max(smile, sstep(0.12, 0.35, x) * (1 - sstep(1.3, 1.7, x)));
    wig = Math.max(wig, 0.6 * sstep(0.3, 0.5, x) * (1 - sstep(1.1, 1.5, x)));
  }
  return { jig, smile, wig, wave, wv };
}
