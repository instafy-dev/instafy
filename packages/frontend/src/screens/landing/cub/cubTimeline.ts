// Every moment of Octo's turn that Cub reacts to, as data.
//
// The owner-approved prototype (not in this repo) polled one shared demo
// clock every frame against about thirty hard-coded thresholds. They all live
// in one CubTimeline table now. Times are seconds into the turn ("td") unless marked as sim time.
// PROTOTYPE_TIMELINE holds the approved prototype's values (a 60 s scenario in
// which Octo works from 4.4 s to 10.8 s); the landing deck retimes it to its
// own beats and drives the engine with setTurn() or a getTurnTime callback.

import { smoother, sstep } from "./cubMath";

/** A [start, end] window in turn seconds. */
export type CubWindow = readonly [number, number];
/** Rise from a to b, fall from c to d: sstep(a, b) * (1 - sstep(c, d)). */
export type CubPlateau = readonly [number, number, number, number];

/** Something on the page Cub's eyes can be scripted to look at. */
export type CubPoiName =
  | "opener"
  | "composer"
  | "own"
  | "octoMessage"
  | "file"
  | "coin"
  | "title"
  | "chips"
  | "roster"
  | "camera";

export interface CubGazeStep {
  /** This step holds until td reaches this value. */
  until: number;
  poi: CubPoiName;
  /** Horizontal fraction across the target: from -> to while td runs through ramp. */
  fx?: readonly [number, number];
  ramp?: CubWindow;
  /** Octo's message: hop between random spots every period seconds from `from`. */
  scan?: { from: number; period: number; fx: readonly [number, number] };
  /** Look at Octo's coin inside these windows and within nearTaps seconds of each tap. */
  coin?: { windows: readonly CubWindow[]; nearTaps: number };
}

export interface CubTapShape {
  /** The coin dip under a tap: in, hold until, out until (seconds after the tap). */
  dipIn: number;
  dipHold: number;
  dipEnd: number;
  /** The tip flick before the tap lands: starts this long before, ends this long after. */
  flickLead: number;
  flickEnd: number;
  /** The coin reads as pressed between these offsets after a tap (onCoinPress). */
  pressFrom: number;
  pressTo: number;
}

export interface CubTimeline {
  /**
   * Octo's coin pop (a CSS scale in the prototype): start, settle and scale
   * growth. press is how the popped coin reads under a tap (the host's pressed
   * style): its scale growth and how far it sinks (css px), so the tip lands on
   * the coin it sees. null when the coin never pops.
   */
  coinPop: { start: number; end: number; scale: number; ramp: number; press?: { scale: number; dy: number } } | null;
  /** The lent arm: reaches from start over rise seconds, lets go from release over fall seconds. */
  reach: { start: number; rise: number; release: number; fall: number };
  /** The arm's role is prepared (and the rest arm makes room) over this window, ramp seconds each side. */
  prepare: { start: number; end: number; ramp: number };
  /** The tip settles just over the coin (hold) between these plateaus. */
  hold: CubPlateau;
  /** Taps on the coin as Octo works (one per step). */
  taps: readonly number[];
  /** Pats once Octo is done. */
  pats: readonly number[];
  tapShape: CubTapShape;
  /** Body lean toward the coin follows the reach until end, then eases out over ramp. */
  lean: { end: number; ramp: number };
  /** A small dip toward the coin early in the reach. */
  coinDip: CubPlateau;
  /** A nod toward the file chip as the answer lands. */
  fileNod: CubPlateau;
  /** The done nod: rise window, fall window, oscillation period. */
  nod: { rise: CubWindow; fall: CubWindow; period: number };
  /** Done: the camera look and jig at t, a blink at blinkIn, a soft happy blink at softBlink. */
  done: { t: number; blinkIn: number; softBlink: number };
  /** The reach arm is busy (never the curious arm) inside this window. */
  busy: CubWindow;
  /** Extra windows that keep the loop at full frame rate. */
  active: readonly CubWindow[];
  /** Scripted gaze, in order; after the last step Cub's eyes wander. */
  gaze: readonly CubGazeStep[];
  /** Sim time (seconds after the loop first runs): the hello jig at t, the happy squint from in to out. */
  hello: { t: number; in: number; out: number };
}

export const PROTOTYPE_TIMELINE: CubTimeline = {
  coinPop: { start: 4.4, end: 11.45, scale: 0.16, ramp: 0.3, press: { scale: 0.04, dy: 1 } },
  reach: { start: 4.3, rise: 1.6, release: 11.25, fall: 1.9 },
  prepare: { start: 3.6, end: 12.7, ramp: 0.65 },
  hold: [5.45, 5.85, 11.4, 11.7],
  taps: [6, 7.6, 9.2],
  pats: [10.85, 10.85 + 0.27],
  tapShape: { dipIn: 0.1, dipHold: 0.18, dipEnd: 0.3, flickLead: 0.15, flickEnd: 0.1, pressFrom: 0.1, pressTo: 0.24 },
  lean: { end: 11.4, ramp: 0.5 },
  coinDip: [5.7, 6.4, 7.2, 7.7],
  fileNod: [10.75, 11.15, 11.55, 11.95],
  nod: { rise: [11.85, 12.05], fall: [12.75, 13.05], period: 0.5 },
  done: { t: 11.9, blinkIn: 12.07, softBlink: 11.9 + 1 },
  busy: [4.4, 13.2],
  active: [
    [5.6, 7.8],
    [10.7, 13.5],
  ],
  gaze: [
    { until: 1.4, poi: "opener", fx: [0.1, 0.6], ramp: [0.2, 1.3] },
    { until: 3.5, poi: "composer", fx: [0.08, 0.68], ramp: [1.6, 3.4] },
    { until: 4.5, poi: "own", fx: [0.35, 0.75], ramp: [3.7, 4.4] },
    {
      until: 10.8,
      poi: "octoMessage",
      scan: { from: 4.5, period: 1.15, fx: [0.12, 0.62] },
      coin: { windows: [[5.75, 7.45]], nearTaps: 0.25 },
    },
    { until: 11.9 + 0.05, poi: "file" },
    { until: 11.9 + 1.2, poi: "camera" },
  ],
  hello: { t: 1.2, in: 1.5, out: 3.27 },
};

/** How long after the hello's jig its smile and wave settle (the happy squint ends at hello.out). */
export const HELLO_TAIL = 0.7;
/** How far after the turn's busy window a deferred hello starts, and the clock jitter it tolerates. */
const HELLO_SLACK = 0.15;
/**
 * A deferred hello's squint starts at least this long after the done soft
 * blink has ended (SOFT_SPAN), so three eye closures never run together.
 */
const HELLO_REST = 1.2;
const SOFT_SPAN = 0.53;

/**
 * Cub notices the visitor before (or after) he lends Octo an arm, never
 * while: the hello is scheduled in sim time, the reach in turn time, and a
 * page that starts both together would play the squint and the wave over the
 * reach. Given the sim clock and the turn time now, returns the hello's shift
 * (sim seconds added to tl.hello) that keeps the whole hello out of the
 * turn's busy window, deferring it until the arm is home. A hello already
 * under way is never moved.
 */
export function helloShiftFor(tl: CubTimeline, simNow: number, td: number, shift: number): number {
  const h = tl.hello;
  const start = h.t + shift;
  if (simNow > start - 0.05) return shift;
  const at = (s: number) => td + (s - simNow);
  const [b0, b1] = tl.busy;
  // The sim clock and the turn clock tick apart by a few ms a frame: a
  // deferred hello lands HELLO_SLACK after the busy window and is left alone
  // within that slack, so frame jitter never walks it later.
  // Deferred, it waits for the arm to be home and for Cub's eyes to rest
  // after the done look's soft blink.
  const late = Math.max(b1 + HELLO_SLACK, tl.done.softBlink + SOFT_SPAN + HELLO_REST - (h.in - h.t) - 0.1);
  if (at(h.out + shift + HELLO_TAIL) <= b0 || at(start - 0.1) >= late - HELLO_SLACK) return shift;
  return shift + (late - at(start - 0.1));
}

/** A sample of the turn clock: seconds into the turn, and whether a turn is playing. */
export interface CubTurnSample {
  td: number;
  live: boolean;
}

/** The turn time reported while nothing plays (the prototype's finished frame). */
export const IDLE_TD = 15;

const plateau = (p: CubPlateau, x: number): number => sstep(p[0], p[1], x) * (1 - sstep(p[2], p[3], x));

/** How far the lent arm is out (0..1). */
export const reachW = (tl: CubTimeline, td: number): number =>
  smoother((td - tl.reach.start) / tl.reach.rise) * (1 - smoother((td - tl.reach.release) / tl.reach.fall));

/** The reach arm's role preparation (0..1). */
export const prepareW = (tl: CubTimeline, td: number): number =>
  smoother((td - tl.prepare.start) / tl.prepare.ramp) * (1 - smoother((td - tl.prepare.end) / tl.prepare.ramp));

export const holdW = (tl: CubTimeline, td: number): number => plateau(tl.hold, td);

/** Octo's coin pop (0..1); multiply by coinPop.scale / 2 for the top edge's rise as a fraction of the coin. */
export function popW(tl: CubTimeline, td: number): number {
  const p = tl.coinPop;
  if (!p) return 0;
  return sstep(p.start, p.start + p.ramp, td) * (1 - sstep(p.end, p.end + p.ramp, td));
}

export const leanW = (tl: CubTimeline, td: number, wR: number): number =>
  wR * (1 - smoother((td - tl.lean.end) / tl.lean.ramp));
export const coinDipW = (tl: CubTimeline, td: number): number => plateau(tl.coinDip, td);
export const fileNodW = (tl: CubTimeline, td: number): number => plateau(tl.fileNod, td);
export const nodEnv = (tl: CubTimeline, td: number): number =>
  sstep(tl.nod.rise[0], tl.nod.rise[1], td) * (1 - sstep(tl.nod.fall[0], tl.nod.fall[1], td));
export const nodAt = (tl: CubTimeline, td: number): number =>
  nodEnv(tl, td) * Math.sin((Math.PI * 2 * (td - tl.nod.rise[0])) / tl.nod.period);

/** Every tap and pat, in time order. */
export const tapTimes = (tl: CubTimeline): number[] => [...tl.taps, ...tl.pats];

function tapDipOne(s: CubTapShape, x: number): number {
  if (x < 0 || x >= s.dipEnd) return 0;
  if (x < s.dipIn) return smoother(x / s.dipIn);
  if (x < s.dipHold) return 1;
  return 1 - smoother((x - s.dipHold) / (s.dipEnd - s.dipHold));
}
function tapFlOne(s: CubTapShape, x: number): number {
  if (x < -s.flickLead || x >= s.flickEnd) return 0;
  if (x < 0) return smoother((x + s.flickLead) / s.flickLead);
  return 1 - smoother(x / s.flickEnd);
}

/** The tap envelopes at td: the coin dip, the tip flick, and the dip carried from a neighbouring tap. */
export function tapAt(tl: CubTimeline, td: number): { dip: number; fl: number; carry: number } {
  const T = tapTimes(tl);
  let dip = 0;
  let fl = 0;
  let k = -1;
  T.forEach((s, i) => {
    dip = Math.max(dip, tapDipOne(tl.tapShape, td - s));
    const f = tapFlOne(tl.tapShape, td - s);
    if (f > fl) {
      fl = f;
      k = i;
    }
  });
  let carry = 0;
  T.forEach((s, i) => {
    if (i !== k) carry = Math.max(carry, tapDipOne(tl.tapShape, td - s));
  });
  return { dip, fl, carry };
}

/** 1 while any tap is in its flick-to-dip window. */
export function tapDip(tl: CubTimeline, td: number): number {
  let m = 0;
  for (const s of tapTimes(tl)) m = Math.max(m, td - s >= -tl.tapShape.flickLead && td - s < tl.tapShape.dipEnd ? 1 : 0);
  return m;
}

/** Whether Octo's coin reads as pressed at td. */
export const pressOn = (tl: CubTimeline, td: number): boolean =>
  tapTimes(tl).some((s) => td >= s + tl.tapShape.pressFrom && td < s + tl.tapShape.pressTo);

/**
 * How pressed Octo's coin looks at td (0..1): the host eases into its pressed
 * style in about 0.06 s and back out in about 0.3 s (tailwind.css), so the tip
 * follows the coin as drawn rather than the press switch.
 */
export function pressW(tl: CubTimeline, td: number): number {
  const { pressFrom, pressTo } = tl.tapShape;
  let w = 0;
  for (const s of tapTimes(tl)) w = Math.max(w, sstep(s + pressFrom, s + pressFrom + 0.06, td) * (1 - sstep(s + pressTo, s + pressTo + 0.3, td)));
  return w;
}

export const busyAt = (tl: CubTimeline, td: number): boolean => td > tl.busy[0] && td < tl.busy[1];

/** Whether the turn needs the full frame rate at td (reach transitions, taps, the scripted windows). */
export function turnActive(tl: CubTimeline, td: number): boolean {
  const w = reachW(tl, td);
  if ((w > 0.002 && w < 0.998) || tapDip(tl, td) > 0.01) return true;
  if (tl.pats.length) {
    const a = Math.min(...tl.pats);
    const b = Math.max(...tl.pats);
    if (td > a - 0.5 && td < b + 0.5) return true;
  }
  return tl.active.some(([a, b]) => td > a && td < b);
}

/**
 * Checks a timeline for values that would break the choreography: non-finite
 * numbers, windows that run backwards, taps outside the reach, gaze steps out
 * of order. Returns human-readable problems; an empty list means it is sound.
 */
export function validateTimeline(tl: CubTimeline): string[] {
  const out: string[] = [];
  const fin = (name: string, v: number) => {
    if (!Number.isFinite(v)) out.push(`${name} is not a finite number`);
  };
  const win = (name: string, a: number, b: number) => {
    fin(`${name}[0]`, a);
    fin(`${name}[1]`, b);
    if (a > b) out.push(`${name} runs backwards (${a} > ${b})`);
  };
  const r = tl.reach;
  fin("reach.start", r.start);
  if (!(r.rise > 0)) out.push("reach.rise must be positive");
  if (!(r.fall > 0)) out.push("reach.fall must be positive");
  win("reach", r.start + r.rise, r.release);
  win("prepare", tl.prepare.start, tl.prepare.end);
  if (!(tl.prepare.ramp > 0)) out.push("prepare.ramp must be positive");
  win("hold.rise", tl.hold[0], tl.hold[1]);
  win("hold.fall", tl.hold[2], tl.hold[3]);
  win("hold", tl.hold[1], tl.hold[2]);
  for (const p of [tl.coinDip, tl.fileNod]) {
    win("plateau.rise", p[0], p[1]);
    win("plateau.fall", p[2], p[3]);
  }
  win("nod.rise", tl.nod.rise[0], tl.nod.rise[1]);
  win("nod.fall", tl.nod.fall[0], tl.nod.fall[1]);
  if (!(tl.nod.period > 0)) out.push("nod.period must be positive");
  if (tl.coinPop) win("coinPop", tl.coinPop.start, tl.coinPop.end);
  win("busy", tl.busy[0], tl.busy[1]);
  tl.active.forEach((w, i) => win(`active[${i}]`, w[0], w[1]));
  const T = tapTimes(tl);
  T.forEach((s, i) => {
    fin(`tap[${i}]`, s);
    if (s < r.start + r.rise * 0.5 || s > r.release) out.push(`tap ${s} falls outside the reach (${r.start}..${r.release})`);
    if (i > 0 && s <= T[i - 1]) out.push(`taps are not in time order at ${s}`);
  });
  const sh = tl.tapShape;
  if (!(sh.dipIn > 0 && sh.dipIn <= sh.dipHold && sh.dipHold < sh.dipEnd)) out.push("tapShape dip envelope is not ordered");
  if (!(sh.flickLead > 0 && sh.flickEnd > 0)) out.push("tapShape flick needs positive lead and end");
  if (!(sh.pressFrom < sh.pressTo)) out.push("tapShape press window runs backwards");
  win("done", tl.done.t, tl.done.softBlink);
  if (tl.done.blinkIn < tl.done.t) out.push("done.blinkIn comes before done.t");
  let prev = -Infinity;
  tl.gaze.forEach((g, i) => {
    fin(`gaze[${i}].until`, g.until);
    if (g.until <= prev) out.push(`gaze[${i}] ends before the step before it`);
    prev = g.until;
    if (g.ramp) win(`gaze[${i}].ramp`, g.ramp[0], g.ramp[1]);
    if (g.scan && !(g.scan.period > 0)) out.push(`gaze[${i}].scan.period must be positive`);
  });
  win("hello", tl.hello.in, tl.hello.out);
  return out;
}
