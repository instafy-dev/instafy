// Cub's choreography retimed to the landing example's own turn.
//
// The approved prototype played one 60 s scenario in which Octo worked for
// 6.4 s and Cub tapped Octo's coin three times, 1.6 s apart. The landing deck
// stays at least 11 s on a scenario, Octo's workspace run goes from the
// thinking beat (1.9 s) to done (4.85 s) in every scenario (a browser handoff
// follows it in the site scenario, after the arm is home), and its five steps
// land 0.45 s apart (landingTurnScript.ts). Every moment Cub reacts to is
// derived from those beats here, so retiming the deck retimes Cub with it:
// - the lent arm sets out while the prompt is still being typed and arrives
//   just as the first step starts, so it is resting over the coin when Octo
//   begins (a slower rise than the beats alone would allow);
// - one tap per step, two pats at done, then the arm lets go and is home
//   well before Kim starts typing;
// - Octo's coin pops from the thinking beat until the pats are over (the
//   counts beat), the way the prototype held its pop just past the pats;
// - the eyes follow the prompt as it is typed, the sent message, Octo's
//   message while it works (with a look at the coin as the arm arrives and
//   again at the fourth step, when the scenario's agent joins the roster),
//   the file chip, then the visitor.

import { BEAT, OCTO_COIN_POP_BEATS, TURN_BEATS } from "../landingTurnScript";
import type { CubTimeline } from "./cubTimeline";

const at = (beat: number): number => TURN_BEATS[beat].atMs / 1000;

const SEND = at(BEAT.SEND);
const OWN = at(BEAT.OWN);
const THINKING = at(BEAT.THINKING);
const STEP1 = at(BEAT.STEP1);
const STEP4 = at(BEAT.STEP4);
const DONE = at(BEAT.DONE);
const FILES = at(BEAT.FILES);
const TYPING = at(BEAT.TYPING);

/** Seconds between the two pats once Octo is done (the prototype's spacing). */
const PAT_GAP = 0.27;
/** The arm is fully out this long before the first step lands. */
const ARRIVE_LEAD = 0.05;
/** How long the arm takes to reach the coin. The prototype took 1.6 s; 1.1 s still reads as unhurried. */
const RISE = 1.1;
const REACH_START = STEP1 - ARRIVE_LEAD - RISE;
const PATS = [DONE, DONE + PAT_GAP] as const;
/** The arm lets go just after the second pat starts and is home FALL seconds later. */
const RELEASE = PATS[1] + 0.18;
const FALL = 1.3;
/** Done: the camera look and jig once the pats are over and the file chip has landed. */
const DONE_T = Math.max(RELEASE + 0.1, FILES + 0.25);

/** Octo's roster coin is popped from the first beat up to, not including, the second (the host pops it over the same beats). */
export const LANDING_CUB_POP_BEATS = OCTO_COIN_POP_BEATS;

export const LANDING_CUB_TIMELINE: CubTimeline = {
  // The host pops Octo's roster coin over the same beats (LANDING_CUB_POP_BEATS,
  // a CSS scale of 1.16 over 0.3 s) and presses it under each tap (scale 1.04,
  // 1 px down: tailwind.css, [data-cub-pop][data-cub-press]): the engine only
  // needs to know when and how, so the tip lands on the coin as drawn.
  coinPop: {
    start: at(LANDING_CUB_POP_BEATS[0]),
    end: at(LANDING_CUB_POP_BEATS[1]),
    scale: 0.16,
    ramp: 0.3,
    press: { scale: 0.04, dy: 1 },
  },
  reach: { start: REACH_START, rise: RISE, release: RELEASE, fall: FALL },
  prepare: { start: REACH_START - 0.55, end: RELEASE + FALL - 0.45, ramp: 0.5 },
  hold: [STEP1 - 0.3, STEP1 - 0.05, RELEASE + 0.1, RELEASE + 0.4],
  taps: [BEAT.STEP1, BEAT.STEP2, BEAT.STEP3, BEAT.STEP4, BEAT.STEP5].map(at),
  pats: PATS,
  // The prototype's tap envelope: 0.45 s from flick to settled, which is
  // exactly one step, so the taps run back to back without overlapping.
  tapShape: { dipIn: 0.1, dipHold: 0.18, dipEnd: 0.3, flickLead: 0.15, flickEnd: 0.1, pressFrom: 0.1, pressTo: 0.24 },
  lean: { end: RELEASE + 0.15, ramp: 0.5 },
  coinDip: [STEP1 - 0.25, STEP1 + 0.15, STEP1 + 0.6, STEP1 + 0.95],
  fileNod: [FILES - 0.05, FILES + 0.3, FILES + 0.65, FILES + 0.95],
  nod: { rise: [DONE_T - 0.05, DONE_T + 0.15], fall: [DONE_T + 0.85, DONE_T + 1.15], period: 0.5 },
  done: { t: DONE_T, blinkIn: DONE_T + 0.17, softBlink: DONE_T + 1 },
  busy: [REACH_START - 0.1, RELEASE + FALL + 0.2],
  // Full frame rate for the whole turn: the arm, the taps and the eyes move
  // continuously from the reach to the done look.
  active: [[REACH_START - 0.2, DONE_T + 1.4]],
  gaze: [
    { until: TYPING + 0.3, poi: "opener", fx: [0.1, 0.6], ramp: [0, TYPING + 0.25] },
    { until: SEND + 0.06, poi: "composer", fx: [0.08, 0.68], ramp: [TYPING + 0.1, SEND] },
    { until: THINKING, poi: "own", fx: [0.35, 0.75], ramp: [OWN - 0.05, THINKING - 0.05] },
    {
      until: DONE,
      poi: "octoMessage",
      scan: { from: STEP1 + 0.6, period: 0.9, fx: [0.12, 0.62] },
      coin: {
        windows: [
          [THINKING + 0.05, STEP1 + 0.55],
          [STEP4 - 0.1, STEP4 + 0.35],
        ],
        nearTaps: 0,
      },
    },
    { until: DONE_T + 0.05, poi: "file" },
    { until: DONE_T + 1.2, poi: "camera" },
  ],
  // Sim time after the loop first runs: Cub notices the visitor.
  hello: { t: 1.2, in: 1.5, out: 3.27 },
};
