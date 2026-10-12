import { describe, expect, it } from "vitest";
import { BEAT, TURN_BEATS } from "../../landingTurnScript";
import { ROTATE_INTERVAL_MS } from "../../useLandingScenarioDeck";
import { HELLO_TAIL, IDLE_TD, helloShiftFor, popW, pressOn, reachW, tapTimes, turnActive, validateTimeline } from "../cubTimeline";
import { LANDING_CUB_POP_BEATS, LANDING_CUB_TIMELINE as TL } from "../landingCubTimeline";

// Cub's choreography must stay inside one turn of the landing example and in
// step with its beats: the deck rotates every ROTATE_INTERVAL_MS and restarts
// the turn, so anything still moving at the rotation would be cut off.

const at = (beat: number) => TURN_BEATS[beat].atMs / 1000;
const ROTATION = ROTATE_INTERVAL_MS / 1000;
const STEPS = [BEAT.STEP1, BEAT.STEP2, BEAT.STEP3, BEAT.STEP4, BEAT.STEP5].map(at);

describe("Cub's timeline on the landing", () => {
  it("is sound", () => {
    expect(validateTimeline(TL)).toEqual([]);
  });

  it("taps once per step and pats twice once Octo is done", () => {
    expect([...TL.taps]).toEqual(STEPS);
    expect(TL.pats[0]).toBe(at(BEAT.DONE));
    expect(TL.pats[1]).toBeGreaterThan(TL.pats[0]);
    // One tap's envelope (flick lead to settled dip) never runs into the next.
    const span = TL.tapShape.flickLead + TL.tapShape.dipEnd;
    const all = tapTimes(TL);
    for (let i = 1; i < all.length; i++) expect(all[i] - all[i - 1]).toBeGreaterThanOrEqual(Math.min(span, 0.27) - 1e-9);
    for (let i = 1; i < STEPS.length; i++) expect(STEPS[i] - STEPS[i - 1]).toBeGreaterThanOrEqual(span - 1e-9);
  });

  it("has the arm out over the coin before the first step and through the pats", () => {
    // Fully out (and settled over the coin) by the first tap's flick.
    expect(reachW(TL, STEPS[0] - TL.tapShape.flickLead)).toBeGreaterThan(0.95);
    expect(TL.hold[1]).toBeLessThanOrEqual(STEPS[0]);
    // Still out for the last pat, letting go only after it lands.
    expect(reachW(TL, TL.pats[1] + TL.tapShape.pressTo)).toBeGreaterThan(0.95);
    expect(TL.reach.release).toBeGreaterThan(TL.pats[1]);
    // It sets out no earlier than the prompt starts typing.
    expect(TL.reach.start).toBeGreaterThanOrEqual(at(BEAT.TYPING));
    expect(TL.prepare.start).toBeGreaterThanOrEqual(0);
  });

  it("presses Octo's coin only with a tap, and pops it over the deck's beats", () => {
    for (const s of tapTimes(TL)) expect(pressOn(TL, s + (TL.tapShape.pressFrom + TL.tapShape.pressTo) / 2)).toBe(true);
    expect(pressOn(TL, at(BEAT.THINKING))).toBe(false);
    expect(TL.coinPop).not.toBeNull();
    expect(TL.coinPop!.start).toBe(at(LANDING_CUB_POP_BEATS[0]));
    expect(TL.coinPop!.end).toBe(at(LANDING_CUB_POP_BEATS[1]));
    expect(popW(TL, (STEPS[0] + STEPS[4]) / 2)).toBe(1);
    // Every tap and pat lands on the popped coin, as the CSS pop holds through the pats.
    for (const s of tapTimes(TL)) expect(s).toBeLessThan(TL.coinPop!.end);
  });

  it("finishes everything well inside one rotation, before Kim replies", () => {
    const home = TL.reach.release + TL.reach.fall;
    expect(home).toBeLessThanOrEqual(at(BEAT.KIM_TYPING));
    const ends = [
      home,
      TL.prepare.end + TL.prepare.ramp,
      TL.hold[3],
      TL.lean.end + TL.lean.ramp,
      TL.coinDip[3],
      TL.fileNod[3],
      TL.nod.fall[1],
      TL.done.softBlink + 1,
      TL.busy[1],
      ...TL.active.map((w) => w[1]),
      TL.gaze[TL.gaze.length - 1].until,
    ];
    for (const end of ends) expect(end).toBeLessThan(ROTATION);
    // The turn is quiet at the rotation and in the idle frame.
    expect(reachW(TL, ROTATION)).toBe(0);
    expect(turnActive(TL, ROTATION - 0.01)).toBe(false);
    expect(turnActive(TL, IDLE_TD)).toBe(false);
  });

  it("notices the visitor before or after lending the arm, never during the reach", () => {
    const H = TL.hello;
    // The hello's whole span in turn time, for an engine that starts at sim 0 at turn time td0.
    const span = (td0: number, shift: number) => [td0 + H.t + shift - 0.1, td0 + H.out + shift + HELLO_TAIL];
    const clear = ([a, b]: number[]) => b <= TL.busy[0] || a >= TL.busy[1];
    // Cub's first frame and the deck's first turn start together (the production build):
    // the hello would cover the reach, so it waits until the arm is home.
    for (const td0 of [0, 0.1, 0.5, 2, 4, 6]) {
      const shift = helloShiftFor(TL, 0, td0, 0);
      expect(clear(span(td0, shift))).toBe(true);
      expect(span(td0, shift)[1]).toBeLessThan(ROTATION + TL.busy[0]);
    }
    // Deferred, the squint starts at least 1.2 s after the done soft blink ends.
    for (const td0 of [0, 0.5, 2]) {
      const shift = helloShiftFor(TL, 0, td0, 0);
      expect(td0 + H.in + shift).toBeGreaterThanOrEqual(TL.done.softBlink + 0.53 + 1.2 - 1e-9);
    }
    // Starting after the arm is home and the eyes have rested, the hello plays on time.
    expect(helloShiftFor(TL, 0, 7.5, 0)).toBe(0);
    // Stable frame to frame once deferred, and a hello under way is never moved.
    const s0 = helloShiftFor(TL, 0, 0.1, 0);
    expect(helloShiftFor(TL, 0.5, 0.6, s0)).toBeCloseTo(s0, 9);
    expect(helloShiftFor(TL, H.t + 0.2, 1.5, 0)).toBe(0);
    // The two clocks tick apart by a few ms a frame: that jitter never walks a deferred hello later.
    let shift = s0;
    let sim = 0;
    let td = 0.1;
    for (let k = 0; k < 600; k++) {
      sim += 1 / 60 + (k % 2 ? 0.004 : -0.004) + 0.0001;
      td += 1 / 60;
      shift = helloShiftFor(TL, sim, td, shift);
    }
    expect(shift).toBeCloseTo(s0, 9);
  });

  it("looks where the turn is happening, in beat order", () => {
    const steps = TL.gaze.map((g) => [g.poi, g.until] as const);
    expect(steps.map(([poi]) => poi)).toEqual(["opener", "composer", "own", "octoMessage", "file", "camera"]);
    const until = Object.fromEntries(steps);
    expect(until.composer).toBeGreaterThanOrEqual(at(BEAT.SEND));
    expect(until.own).toBe(at(BEAT.THINKING));
    expect(until.octoMessage).toBe(at(BEAT.DONE));
    // The camera look (done) comes after the file chip has landed and the pats are over.
    expect(TL.done.t).toBeGreaterThanOrEqual(at(BEAT.FILES));
    expect(TL.done.t).toBeGreaterThanOrEqual(TL.pats[1]);
  });
});
