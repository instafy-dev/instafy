// The lent arm on the landing's own layout, frame by frame through the turn:
// it sets out, taps Octo's coin and comes home without folding back on
// itself, stretching into a straight stroke, or kinking.
import { describe, expect, it } from "vitest";
import { ARM_R0, K, SS, TAP_LAND } from "../cubConfig";
import { build } from "../cubBuild";
import { coinDrawn, reachArmOf } from "../cubReach";
import { armTaper } from "../cubRig";
import type { ArmBuf, Cub } from "../cubState";
import { popW, pressW, tapAt, tapTimes } from "../cubTimeline";
import { LANDING_CUB_TIMELINE as TL } from "../landingCubTimeline";
import { applyLayout } from "../cubLayout";
import { createCubState, resolveOptions } from "../cubState";
import { LANDING_CUB_LAYOUT } from "../landingCub";
import { LANDING_LAYOUTS as LAYOUTS, landingCubAt as cubAt } from "./landingFixture";

/** The lent arm's spine at turn time td. */
function spineAt(c: Cub, td: number): { x: number[]; y: number[] } {
  c.turnOverride = { td, live: true };
  build(c, 30 + td);
  c.turnOverride = null;
  const o = c.OC.parm![reachArmOf(c)];
  return { x: Array.from(o.X), y: Array.from(o.Y) };
}

const segs = (s: { x: number[]; y: number[] }) => Array.from({ length: K - 1 }, (_, j) => Math.hypot(s.x[j + 1] - s.x[j], s.y[j + 1] - s.y[j]));

function crosses(s: { x: number[]; y: number[] }): [number, number] | null {
  const cr = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  for (let i = 0; i < K - 1; i++)
    for (let j = i + 2; j < K - 1; j++) {
      const [x1, y1, x2, y2, x3, y3, x4, y4] = [s.x[i], s.y[i], s.x[i + 1], s.y[i + 1], s.x[j], s.y[j], s.x[j + 1], s.y[j + 1]];
      const d1 = cr(x3, y3, x4, y4, x1, y1);
      const d2 = cr(x3, y3, x4, y4, x2, y2);
      const d3 = cr(x1, y1, x2, y2, x3, y3);
      const d4 = cr(x1, y1, x2, y2, x4, y4);
      if (d1 * d2 < 0 && d3 * d4 < 0) return [i, j];
    }
  return null;
}

const STEP = 1 / 60;
const sweep = (a: number, b: number) => Array.from({ length: Math.round((b - a) / STEP) + 1 }, (_, k) => a + k * STEP);
const RISE = sweep(TL.prepare.start - 0.1, TL.reach.start + TL.reach.rise + 0.3);
const FALL = sweep(TL.reach.release - 0.1, TL.prepare.end + TL.prepare.ramp + 0.1);

describe("the lent arm on the landing", () => {
  for (const size of Object.keys(LAYOUTS)) {
    it(`sets out and comes home cleanly at ${size} (${LAYOUTS[size].mode})`, () => {
      const c = cubAt(size);
      expect(c.OC.mode).toBe(LAYOUTS[size].mode);
      const ref = Math.max(...[0.3, (TL.hold[1] + TL.hold[2]) / 2].map((td) => segs(spineAt(c, td)).reduce((a, b) => a + b, 0)));
      const report: string[] = [];
      const G = c.G!;
      const co = c.L!.octoCoin;
      const cc = co.x + co.w / 2;
      const reachX = co.w / 2 + 0.35 * c.OC.u;
      for (const td of [...RISE, ...FALL]) {
        const s = spineAt(c, td);
        const L = segs(s);
        const len = L.reduce((a, b) => a + b, 0);
        const mean = len / (K - 1);
        if (len > 1.25 * ref) report.push(`td ${td.toFixed(3)}: length ${len.toFixed(0)} > 1.25 x ${ref.toFixed(0)}`);
        const long = Math.max(...L);
        if (long > 3 * mean) report.push(`td ${td.toFixed(3)}: a ${long.toFixed(1)} px straight run (mean ${mean.toFixed(1)})`);
        const x = crosses(s);
        if (x) report.push(`td ${td.toFixed(3)}: crosses itself (segments ${x[0]} and ${x[1]})`);
        // Over the window's face the arm hangs below the ledge only on its way down to the coin.
        for (let j = 0; j < K; j++)
          if (s.y[j] > G.edgeY + 2 && s.x[j] > G.wx0 && s.x[j] < G.wx1 && Math.abs(s.x[j] - cc) > reachX) {
            report.push(`td ${td.toFixed(3)}: joint ${j} hangs over the window at x ${s.x[j].toFixed(0)}, away from the coin`);
            break;
          }
      }
      expect(report).toEqual([]);
    });
  }
});

/** Every arm at sim time t (turn time td, or no turn). */
function armsAt(c: Cub, t: number, td: number | null): { arms: ArmBuf[]; roles: string[] } {
  c.turnOverride = td == null ? { td: 15, live: false } : { td, live: true };
  build(c, t);
  c.turnOverride = null;
  return { arms: c.OC.parm!, roles: c.OC.roles! };
}

/** Whether two arms' spines cross past the first quarter of each (the roots share the crown). */
function armsCross(a: ArmBuf, b: ArmBuf): boolean {
  const cr = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const j0 = SS.findIndex((s) => s > 0.25);
  for (let i = j0; i < K - 1; i++)
    for (let j = j0; j < K - 1; j++) {
      const d1 = cr(b.X[j], b.Y[j], b.X[j + 1], b.Y[j + 1], a.X[i], a.Y[i]);
      const d2 = cr(b.X[j], b.Y[j], b.X[j + 1], b.Y[j + 1], a.X[i + 1], a.Y[i + 1]);
      const d3 = cr(a.X[i], a.Y[i], a.X[i + 1], a.Y[i + 1], b.X[j], b.Y[j]);
      const d4 = cr(a.X[i], a.Y[i], a.X[i + 1], a.Y[i + 1], b.X[j + 1], b.Y[j + 1]);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  return false;
}

describe("Octo's coin under the lent arm", () => {
  for (const size of Object.keys(LAYOUTS)) {
    it(`lands each tap on the coin as drawn (popped and pressed) at ${size}`, () => {
      const c = cubAt(size);
      const u = c.OC.u;
      const rt = armTaper(1, ARM_R0 * u);
      const report: string[] = [];
      // From the moment the coin reads fully pressed to the end of the dip's
      // hold, unless the next pat's flick has already lifted the tip.
      let checked = 0;
      for (const s of tapTimes(TL))
        for (let td = s + TL.tapShape.pressFrom + 0.06; td <= s + TL.tapShape.dipHold + 1e-9; td += 0.01) {
          if (tapAt(TL, td).fl > 0) continue;
          checked++;
          const { arms } = armsAt(c, 30 + td, td);
          const arm = arms[reachArmOf(c)];
          const k = coinDrawn(c, popW(TL, td), pressW(TL, td));
          // The tip's edge to the coin's ring: touching, at most TAP_LAND into it.
          const gap = Math.hypot(arm.X[K - 1] - k.cx, arm.Y[K - 1] - k.cy) - k.r - rt;
          if (gap > 0.75 || gap < -TAP_LAND - 0.75) report.push(`td ${td.toFixed(2)}: the tip is ${gap.toFixed(2)} px off the coin`);
        }
      expect(report).toEqual([]);
      // Every tap and the first pat are checked.
      expect(checked).toBeGreaterThanOrEqual(3 * TL.taps.length);
    });

    it(`lends a short hook onto the coin, not a long drop, at ${size}`, () => {
      const c = cubAt(size);
      const u = c.OC.u;
      const G = c.G!;
      // The prototype's hook drops about 0.2-0.5 u below the ledge; a coin a row lower made a 0.75 u pole.
      const most = (c.L!.mobile ? 0.55 : 0.35) * u;
      let deepest = 0;
      for (let td = TL.hold[1]; td <= TL.hold[2]; td += 0.05) {
        const { arms } = armsAt(c, 30 + td, td);
        const arm = arms[reachArmOf(c)];
        for (let j = 0; j < K; j++) deepest = Math.max(deepest, arm.Y[j] - G.edgeY);
      }
      expect(deepest).toBeGreaterThan(0);
      expect(deepest).toBeLessThanOrEqual(most);
    });
  }
});

describe("the idle arms on the landing", () => {
  for (const size of Object.keys(LAYOUTS)) {
    it(`hang the front arms over the ledge in hooks, never pressed flat, at ${size}`, () => {
      const c = cubAt(size);
      const u = c.OC.u;
      const G = c.G!;
      const report: string[] = [];
      for (let k = 0; k < 60; k++) {
        const t = 30 + 0.37 * k;
        const { arms, roles } = armsAt(c, t, null);
        arms.forEach((o, i) => {
          let x0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          for (let j = 0; j < K; j++)
            if (o.F[j] && o.Y[j] > G.edgeY && o.X[j] > G.wx0 && o.X[j] < G.wx1) {
              x0 = Math.min(x0, o.X[j]);
              x1 = Math.max(x1, o.X[j]);
              y1 = Math.max(y1, o.Y[j]);
            }
          if (x1 - x0 > 0.3 * u && y1 - G.edgeY < 0.15 * u)
            report.push(`t ${t.toFixed(2)}: the ${roles[i]} arm lies flat (${((x1 - x0) / u).toFixed(2)} u wide, ${((y1 - G.edgeY) / u).toFixed(2)} u deep)`);
        });
      }
      expect(report).toEqual([]);
    });
  }

  for (const size of Object.keys(LAYOUTS)) {
    it(`never folds an idle arm back across itself at ${size}`, () => {
      // A narrow page margin beside the corner (1000-1150px) once squashed the
      // peeking arm's curl against the page edge into a knot.
      const c = cubAt(size);
      const report: string[] = [];
      for (let k = 0; k < 120; k++) {
        const t = 30 + 0.23 * k;
        const { arms, roles } = armsAt(c, t, null);
        arms.forEach((o, i) => {
          const x = crosses({ x: Array.from(o.X), y: Array.from(o.Y) });
          if (x) report.push(`t ${t.toFixed(2)}: the ${roles[i]} arm crosses itself (segments ${x[0]} and ${x[1]})`);
        });
      }
      expect(report).toEqual([]);
    });
  }

  it("rests the corner arm in an open hook, clear of the peeking arm, when the margin beside the corner is tight", () => {
    // The 1120 px landing with only 24 px of page right of the window (8 px
    // past the page's 16 px edge keep-out): too little to hang a drape. The
    // arm lies along the ledge to the corner and lifts its tip there; a tip
    // that curled back on itself bunched against the peeking arm's curl into
    // a knot (back 0.16 u, 0.06 u from the curl before the fix).
    const fx = LAYOUTS["1120x800"];
    const a = fx.anchors;
    const width = Math.round(a.window.x + a.window.w + 24);
    const c = createCubState(resolveOptions({ timeline: TL, layout: LANDING_CUB_LAYOUT, still: { t: 30, td: null } }));
    applyLayout(c, { ...a, width }, width, a.height, fx.dpr, true);
    c.built = true;
    expect(c.OC.mode).toBe("corner");
    const u = c.OC.u;
    const report: string[] = [];
    for (let k = 0; k < 120; k++) {
      const t = 30 + 0.23 * k;
      const { arms, roles } = armsAt(c, t, null);
      const corner = arms[roles.indexOf("corner")];
      const curl = arms[roles.indexOf("curl")];
      const x = crosses({ x: Array.from(corner.X), y: Array.from(corner.Y) });
      if (x) report.push(`t ${t.toFixed(2)}: the corner arm crosses itself (segments ${x[0]} and ${x[1]})`);
      const back = Math.max(...corner.X) - corner.X[K - 1];
      if (back > 0.08 * u) report.push(`t ${t.toFixed(2)}: the corner tip curls ${(back / u).toFixed(2)} u back`);
      let near = Infinity;
      for (let i = Math.floor(K * 0.8); i < K; i++)
        for (let j = Math.floor(K * 0.6); j < K; j++) near = Math.min(near, Math.hypot(corner.X[i] - curl.X[j], corner.Y[i] - curl.Y[j]));
      if (near < 0.1 * u) report.push(`t ${t.toFixed(2)}: the corner tip is ${(near / u).toFixed(2)} u from the peeking arm's curl`);
    }
    expect(report).toEqual([]);
  });

  for (const size of Object.keys(LAYOUTS).filter((key) => LAYOUTS[key].mode === "corner")) {
    it(`keeps the corner drape clear of the front arms while Octo borrows an arm at ${size}`, () => {
      const c = cubAt(size);
      const report: string[] = [];
      for (let td = TL.prepare.start - 0.2; td < TL.prepare.end + TL.prepare.ramp + 0.2; td += 1 / 30) {
        const { arms, roles } = armsAt(c, 30 + td, td);
        const corner = roles.indexOf("corner");
        expect(reachArmOf(c)).not.toBe(corner);
        roles.forEach((rl, i) => {
          if ((rl === "dangle" || rl === "grip" || rl === "edgeB") && armsCross(arms[corner], arms[i]))
            report.push(`td ${td.toFixed(2)}: the corner arm crosses the ${rl} arm`);
        });
      }
      expect(report).toEqual([]);
    });
  }
});
