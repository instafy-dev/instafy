import { describe, expect, it } from "vitest";
import { smoother, sstep } from "../cubMath";
import {
  PROTOTYPE_TIMELINE,
  pressOn,
  reachW,
  tapAt,
  tapDip,
  turnActive,
  validateTimeline,
  type CubTimeline,
} from "../cubTimeline";

// The owner-approved prototype's own definitions (not in this repo), kept verbatim as the reference.
const P = {
  reachW: (td: number) => smoother((td - 4.3) / 1.6) * (1 - smoother((td - 11.25) / 1.9)),
  TAPS_T: [6, 7.6, 9.2, 10.85, 10.85 + 0.27],
  tapDipOne: (x: number) => (x < 0 || x >= 0.3 ? 0 : x < 0.1 ? smoother(x / 0.1) : x < 0.18 ? 1 : 1 - smoother((x - 0.18) / 0.12)),
  tapFlOne: (x: number) => (x < -0.15 || x >= 0.1 ? 0 : x < 0 ? smoother((x + 0.15) / 0.15) : 1 - smoother(x / 0.1)),
};
function protoTapAt(td: number) {
  let dip = 0;
  let fl = 0;
  let k = -1;
  P.TAPS_T.forEach((s, i) => {
    dip = Math.max(dip, P.tapDipOne(td - s));
    const f = P.tapFlOne(td - s);
    if (f > fl) {
      fl = f;
      k = i;
    }
  });
  let carry = 0;
  P.TAPS_T.forEach((s, i) => {
    if (i !== k) carry = Math.max(carry, P.tapDipOne(td - s));
  });
  return { dip, fl, carry };
}
const protoPress = (td: number) => P.TAPS_T.some((s) => td >= s + 0.1 && td < s + 0.24);
function protoActive(td: number) {
  const w = P.reachW(td);
  let tapD = 0;
  for (const s of P.TAPS_T) tapD = Math.max(tapD, td - s >= -0.15 && td - s < 0.3 ? 1 : 0);
  return (w > 0.002 && w < 0.998) || tapD > 0.01 || (td > 10.85 - 0.5 && td < 11.12 + 0.5) || (td > 5.6 && td < 7.8) || (td > 10.7 && td < 13.5);
}
const samples = Array.from({ length: 1601 }, (_, i) => i / 100);

describe("CubTimeline", () => {
  it("the prototype table is sound", () => {
    expect(validateTimeline(PROTOTYPE_TIMELINE)).toEqual([]);
  });

  it("reproduces the prototype's reach, tap, press and full-rate windows exactly", () => {
    const tl = PROTOTYPE_TIMELINE;
    for (const td of samples) {
      expect(reachW(tl, td)).toBe(P.reachW(td));
      expect(tapAt(tl, td)).toEqual(protoTapAt(td));
      expect(pressOn(tl, td)).toBe(protoPress(td));
      expect(turnActive(tl, td)).toBe(protoActive(td));
    }
  });

  it("keeps envelopes inside 0..1 and the reach fully out between rise and release", () => {
    const tl = PROTOTYPE_TIMELINE;
    for (const td of samples) {
      const w = reachW(tl, td);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      expect(tapDip(tl, td)).toBeLessThanOrEqual(1);
    }
    expect(reachW(tl, tl.reach.start + tl.reach.rise + 0.01)).toBe(1);
    expect(reachW(tl, tl.reach.start - 0.01)).toBe(0);
    for (const s of tl.taps) expect(sstep(tl.hold[0], tl.hold[1], s)).toBe(1);
  });

  it("flags broken tables", () => {
    const broken: CubTimeline = {
      ...PROTOTYPE_TIMELINE,
      reach: { ...PROTOTYPE_TIMELINE.reach, rise: 0 },
      taps: [9.2, 6, 30],
      gaze: [PROTOTYPE_TIMELINE.gaze[1], PROTOTYPE_TIMELINE.gaze[0]],
      busy: [13, 4],
    };
    const errs = validateTimeline(broken);
    expect(errs.some((e) => e.includes("reach.rise"))).toBe(true);
    expect(errs.some((e) => e.includes("time order"))).toBe(true);
    expect(errs.some((e) => e.includes("outside the reach"))).toBe(true);
    expect(errs.some((e) => e.includes("gaze[1]"))).toBe(true);
    expect(errs.some((e) => e.includes("busy"))).toBe(true);
  });

  it("can be retimed to a shorter turn and stays valid", () => {
    // A compressed turn like the landing deck's (Octo works from about 1.9 s to 4.85 s).
    const k = 0.45;
    const tl = PROTOTYPE_TIMELINE;
    const sc = (v: number) => v * k;
    const retimed: CubTimeline = {
      ...tl,
      coinPop: null,
      reach: { start: sc(tl.reach.start), rise: sc(tl.reach.rise), release: sc(tl.reach.release), fall: sc(tl.reach.fall) },
      prepare: { ...tl.prepare, start: sc(tl.prepare.start), end: sc(tl.prepare.end) },
      hold: tl.hold.map(sc) as unknown as CubTimeline["hold"],
      taps: tl.taps.map(sc),
      pats: tl.pats.map(sc),
      lean: { end: sc(tl.lean.end), ramp: sc(tl.lean.ramp) },
      coinDip: tl.coinDip.map(sc) as unknown as CubTimeline["coinDip"],
      fileNod: tl.fileNod.map(sc) as unknown as CubTimeline["fileNod"],
      nod: { rise: [sc(tl.nod.rise[0]), sc(tl.nod.rise[1])], fall: [sc(tl.nod.fall[0]), sc(tl.nod.fall[1])], period: tl.nod.period },
      done: { t: sc(tl.done.t), blinkIn: sc(tl.done.blinkIn), softBlink: sc(tl.done.softBlink) },
      busy: [sc(tl.busy[0]), sc(tl.busy[1])],
      active: tl.active.map(([a, b]) => [sc(a), sc(b)] as const),
      gaze: tl.gaze.map((g) => ({ ...g, until: sc(g.until), ramp: g.ramp ? ([sc(g.ramp[0]), sc(g.ramp[1])] as const) : undefined })),
    };
    expect(validateTimeline(retimed)).toEqual([]);
    expect(Math.max(...tapTimesOf(retimed))).toBeLessThan(11);
  });
});

const tapTimesOf = (tl: CubTimeline) => [...tl.taps, ...tl.pats];
