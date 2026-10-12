// The engine's mode gates and the turn clock (the owner-approved prototype's
// motionOK, demoMotion, noticeOK and demoAt; the prototype is not in this repo).

import { IDLE_TD, type CubTurnSample } from "./cubTimeline";
import type { Cub } from "./cubState";

/** A deterministic still frame (no animation, no input). */
export const isStill = (c: Cub): boolean => c.o.still != null;
/** Cub animates: not a still, no reduced motion, motion on, and WebGL drawing. */
export const motionOK = (c: Cub): boolean => !c.o.still && !c.rmOn && c.motionOn && c.glOK && !c.glLost;
/** The turn may play (independent of WebGL). */
export const demoMotion = (c: Cub): boolean => !c.o.still && !c.rmOn && c.motionOn;
export const noticeOK = (c: Cub): boolean => motionOK(c) && c.noticeOn;

const IDLE: CubTurnSample = { td: IDLE_TD, live: false };

/** Seconds into the host's turn, and whether a turn plays. */
export function demoAt(c: Cub): CubTurnSample {
  if (c.turnOverride) return c.turnOverride;
  const still = c.o.still;
  if (still) return still.td == null ? IDLE : { td: still.td, live: true };
  if (!demoMotion(c)) return IDLE;
  if (c.getTurnTime) {
    const v = c.getTurnTime();
    return v == null || !Number.isFinite(v) ? IDLE : { td: Math.max(0, v), live: true };
  }
  const tr = c.turn;
  if (!tr.live) return IDLE;
  if ("td" in tr) return { td: tr.td, live: true };
  return { td: Math.max(0, (performance.now() - tr.startedAt) / 1000), live: true };
}

/** Whether a fine pointer (mouse) is in use: attention and the curious arm need one. */
export const fine = (c: Cub): boolean => !!c.fineQ && c.fineQ.matches;
