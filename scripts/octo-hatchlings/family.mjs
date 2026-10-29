// Octo's hatchlings (docs/Brand.md, "Octo's hatchlings"): eight numbered faces
// and the hollow face, as poses for hatch.mjs.
//
// Every face is the same baby: a rounder, taller dome than Octo's, two eyes,
// four chubby curled arms and exactly one dot, drawn small enough that each
// carries less ink than Octo's mark. The faces differ only in body language.
// No arm stands like a leg, nothing lies flat and nothing tilts more than
// about 25 degrees. Hooray, drift and twirl are drawn at the first study's
// size and shrunk to baby size by the builder; the other poses are drawn at
// their final size (`final`). Coordinates are tile units (64 = the tile).
//
// The seat numbers are frozen with the hash modulus (runtime-contracts,
// agent_face.rs): a face added later takes a new seed prefix, and a seat is
// never redrawn into a different gesture.
import { V, rotAbout } from "./geom.mjs";
import { STYLE, arm, mir } from "./hatch.mjs";

const F = (pose) => ({ ...pose, final: true });
/** Arms of a body tilted by t degrees about P. */
const tilt = (P, t) => (s, h, r, o) => arm(rotAbout(s, P, t), h + t, r, o);
/** A hanging arm whose tip curls outward (k = 1 curls left, -1 right). */
const hang = (k, a, b, c, curl) => [{ len: a, turn: 0 }, { len: b, turn: 18 * k }, { len: c, turn: curl * k }];

/** Seats 1 to 8, in order. */
export const HATCHLINGS = [
  {
    // Both outer arms up, the dot tossed overhead.
    name: "hooray",
    pose: () => {
      const O = arm(V(25, 38), 190, [{ len: 6, turn: 35 }, { len: 10.5, turn: 60 }, { len: 5, turn: -130 }]);
      const I = arm(V(29, 41), 105, [{ len: 5, turn: 15 }, { len: 6, turn: 140 }]);
      return { cx: 32, ys: 36.5, arms: [O, mir(O), I, mir(I)], dot: { p: V(32, 11.4), r: 3.1 } };
    },
  },
  {
    // Leaning into a current, arms streaming to the lower right, the dot just ahead.
    name: "drift",
    pose: () => {
      const run = [{ len: 5.5, turn: -45 }, { len: 8, turn: 70 }, { len: 3, turn: 50 }];
      const o = { w1: 3.3 };
      return {
        cx: 30, ys: 31, rot: -10, shift: V(-1, -1),
        arms: [arm(V(25, 33), 110, run, o), arm(V(29, 35), 95, run, o), arm(V(33.5, 35), 80, run, o), arm(V(37.5, 32.5), 60, run, o)],
        dot: { p: V(14.5, 16), r: 3.1 },
      };
    },
  },
  {
    // One arm swung out to the left and rising, the dot flying off its tip;
    // the other three swept back to the right like a skirt in motion.
    name: "kick",
    pose: () => {
      const sweep = [{ len: 4, turn: -15 }, { len: 4, turn: 40 }, { len: 3, turn: 100 }];
      return F({
        cx: 39, ys: 32,
        arms: [arm(V(34.2, 34.7), 178, [{ len: 5, turn: 0 }, { len: 7, turn: 32 }], { w1: 3.8 }), arm(V(37.5, 36.5), 84, sweep), arm(V(41, 36.5), 62, sweep), arm(V(44.5, 34.5), 34, sweep)],
        dot: { beyond: 0, gap: 1.8, r: 3.2 },
      });
    },
  },
  {
    // A pinwheel, every arm sweeping the same way round, the dot flung off the top.
    name: "twirl",
    pose: () => {
      const run = [{ len: 6, turn: -30 }, { len: 8, turn: -120 }];
      return { cx: 32, ys: 33, arms: [arm(V(25, 35), 180, run), arm(V(29, 38), 115, run), arm(V(36, 38), 55, run), arm(V(38.4, 35.7), 0, run)], dot: { p: V(50, 13), r: 3.1 } };
    },
  },
  {
    // Leaning a little toward the dot at its feet and waving one arm raised
    // beside its head, on the left: the side an overlapping stack keeps.
    name: "wave",
    pose: () => {
      const cx = 31;
      const ys = 39.5;
      const t = 18;
      const R = tilt(V(cx, ys), t);
      return F({
        cx, ys, rot: t,
        arms: [
          R(V(cx - 7, ys + 1.3), 190, [{ len: 5, turn: 35 }, { len: 10, turn: 70 }, { len: 4.5, turn: -130 }], { w1: 3.7 }),
          R(V(cx - 3.2, ys + 3.6), 104, hang(1, 3, 4, 4.5, 130), { w1: 3.8 }),
          R(V(cx + 1, ys + 4), 86, hang(-1, 3, 4, 4.5, 130), { w1: 3.8 }),
          R(V(cx + 5.5, ys + 2.6), 62, hang(-1, 3, 4, 4.5, 130), { w1: 3.8 }),
        ],
        dot: { p: V(49, 49.5), r: STYLE.dotR },
      });
    },
  },
  {
    // Stretching one arm up and out to the right after the dot, the other three hanging.
    name: "catch",
    pose: () => {
      const t = 8;
      const R = tilt(V(26.5, 38), t);
      return F({
        cx: 26.5, ys: 38, rot: t,
        arms: [
          R(V(33.1, 39.5), -42, [{ len: 5, turn: -12 }, { len: 9, turn: 10 }], { w0: 4.6, w1: 3.9 }),
          R(V(22, 40.5), 118, hang(1, 3, 4, 5, 130), { w1: 3.8 }),
          R(V(25.5, 42), 98, hang(1, 3, 4, 5, 130), { w1: 3.8 }),
          R(V(29, 42), 80, hang(-1, 3, 4, 5, 130), { w1: 3.8 }),
        ],
        dot: { beyond: 0, gap: 2.0, r: 3.1 },
      });
    },
  },
  {
    // Standing at ease right of centre, arms hanging and curled out, the dot
    // bobbing at hip height to its left.
    name: "rest",
    pose: () => {
      const cx = 37;
      const ys = 38;
      return F({
        cx, ys,
        arms: [
          arm(V(cx - 6, ys + 3.5), 118, hang(1, 4, 4, 4, 130)),
          arm(V(cx - 2.2, ys + 5.5), 98, hang(1, 4, 4, 4, 130)),
          arm(V(cx + 2.2, ys + 5.5), 82, hang(-1, 4, 4, 4, 130)),
          arm(V(cx + 6, ys + 3.5), 62, hang(-1, 4, 4, 4, 130)),
        ],
        dot: { p: V(14, 44), r: STYLE.dotR },
      });
    },
  },
  {
    // Swimming up and to the right, leaning 26 degrees, arms fanned out behind
    // with alternating curls, a bubble left behind.
    name: "swim",
    pose: () => {
      const t = 26;
      const R = tilt(V(37, 29), t);
      return F({
        cx: 37, ys: 29, rot: t,
        arms: [
          R(V(31, 32), 150, [{ len: 4, turn: 15 }, { len: 5, turn: -30 }, { len: 3, turn: 110 }], { w1: 3.8 }),
          R(V(33.5, 33.5), 128, [{ len: 4, turn: -15 }, { len: 5, turn: 30 }, { len: 3, turn: -110 }], { w1: 3.8 }),
          R(V(37, 34), 108, [{ len: 4, turn: 15 }, { len: 4, turn: -30 }, { len: 3, turn: 110 }]),
          R(V(40.5, 33), 88, [{ len: 3, turn: -15 }, { len: 4, turn: 30 }, { len: 3, turn: -110 }]),
        ],
        dot: { p: V(13, 47.5), r: 3.0 },
      });
    },
  },
];

/**
 * The face of an AI the Studio knows only from text: the bare hatchling at
 * rest, symmetric, arms spread with their tips curled out, drawn hollow, with
 * eyes and no dot. It has no seat, so it is never stamped or numbered, and
 * the hollow dome is the one thing no numbered face has.
 */
export const UNKNOWN = {
  name: "unknown",
  pose: () => {
    // The arms hang from the rim, roots below the hollow, so nothing shows inside the head.
    const ys = 28;
    const O = arm(V(26.2, ys + 3.3), 128, [{ len: 4, turn: 0 }, { len: 4, turn: 25 }, { len: 4, turn: 140 }]);
    const I = arm(V(29.8, ys + 4.3), 102, hang(1, 4, 4, 4, 130));
    return F({ cx: 32, ys, arms: [O, mir(O), I, mir(I)], dot: null, hollow: { ring: 2.5, eyeK: 0.9 } });
  },
};
