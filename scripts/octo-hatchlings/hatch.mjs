// Builds a hatchling from its pose and writes it in Octo's mark frame.
//
// A pose names a dome (its shoulder centre and tilt), four turtle-drawn arm
// centrelines and one dot. The builder shrinks a pose drawn at the first
// study's size to baby size, gives every arm a tapered body and a round tip,
// and cuts the eyes out of the dome. The output is what OctoHatchling draws:
// viewBox 0 0 64 64 in Octo's mark frame (drawn at 75% of the tile, centred,
// as OctoMark is), numbers to one decimal, the dome an even-odd path.
import { V, add, armRing, domeSegs, mul, norm, rotAbout, splinePath, sub, turtle } from "./geom.mjs";

export const STYLE = {
  scale: 0.9, // babies: a pose from the first study is drawn at 90%
  w0: 5.0, // arm width at the root, under the dome
  w1: 3.6, // arm width at the tip
  dome: { w: 22, top: 16.5, bot: 6 }, // before scale
  eye: { dx: 4.8, dy: -3.4, r: 2.3 }, // centres before scale, radius after
  dotR: 3.1,
};

/** An arm: start point, heading in degrees, turtle runs, and optional widths { w0, w1 }. */
export const arm = (s, h, r, o = {}) => ({ s, h, r, ...o });

/** The same arm mirrored about the vertical line x = mx. */
export const mir = (a, mx = 32) => ({ ...a, s: V(2 * mx - a.s.x, a.s.y), h: 180 - a.h, r: a.r.map((x) => ({ ...x, turn: -(x.turn ?? 0) })) });

/**
 * Builds a pose into tile-space shapes. A pose is
 * { cx, ys, rot?, shift?, final?, arms, dot, hollow? }: `final` poses are
 * drawn at their final size, the others are scaled to baby size about the
 * dome's shoulder centre. The dot sits at `p`, or flies off arm `beyond`'s
 * tip along its heading.
 */
export function build(pose, style = STYLE) {
  const S = pose.final ? 1 : style.scale;
  const D = style.scale;
  const piv = V(pose.cx, pose.ys);
  const sh = pose.shift ?? V(0, 0);
  const T = (p) => add(add(piv, mul(sub(p, piv), S)), sh);
  const rot = pose.rot ?? 0;
  const dc = T(V(pose.cx, pose.ys));
  const dome = { cx: dc.x, ys: dc.y, rot, w: style.dome.w * D, top: style.dome.top * D, bot: style.dome.bot * D };
  const at = (dx, dy) => rotAbout(V(dome.cx + dx, dome.ys + dy), V(dome.cx, dome.ys), rot);
  const eyes = [at(-style.eye.dx * D, style.eye.dy * D), at(style.eye.dx * D, style.eye.dy * D)].map((p) => ({ x: p.x, y: p.y, r: style.eye.r }));
  // Each root is pushed 1.5 units further into the dome along its first
  // heading, so the straight root closure stays buried. A hollow dome keeps
  // its roots as drawn, below the hollow.
  const ext = pose.hollow ? 0 : 1.5;
  const arms = pose.arms.map((a) => {
    let pts = turtle(a.s, a.h, a.r).map(T);
    if (ext > 0) {
      const d = norm(sub(pts[1], pts[0]));
      pts = [sub(pts[0], mul(d, ext)), ...pts];
    }
    return armRing(pts, { w0: a.w0 ?? style.w0, w1: a.w1 ?? style.w1 });
  });
  let dot = null;
  if (pose.dot && pose.dot.beyond !== undefined) {
    const a = arms[pose.dot.beyond];
    const w1 = pose.arms[pose.dot.beyond].w1 ?? style.w1;
    const r = pose.dot.r ?? style.dotR;
    const off = w1 / 2 + (pose.dot.gap ?? 1.8) + r;
    dot = { x: a.tip.x + a.dir.x * off, y: a.tip.y + a.dir.y * off, r };
  } else if (pose.dot) {
    dot = { ...T(pose.dot.p), r: pose.dot.r ?? style.dotR };
  }
  // The hollow face's dome is the outer dome minus an inner one.
  const hollow = pose.hollow
    ? { w: dome.w - 2 * pose.hollow.ring, top: dome.top - pose.hollow.ring, bot: dome.bot - 0.85 * pose.hollow.ring, ys: dome.ys - 0.15 * D, eyeK: pose.hollow.eyeK }
    : null;
  return { dome, eyes, arms, dot, hollow };
}

/** Tile units to Octo's mark frame: the mark is drawn at 75% of the tile, centred. */
const toMark = (p) => V((p.x - 8) / 0.75, (p.y - 8) / 0.75);
const round = (n) => Math.round(n * 10) / 10;
/** The shortest text for a rounded number: ".5", not "0.5". */
const num = (n) => String(n).replace(/^(-?)0\./, "$1.");
const point = (p) => {
  const m = toMark(p);
  return `${num(round(m.x))} ${num(round(m.y))}`;
};
// A length in the mark frame. Multiplied by 1 / 0.75 rather than divided, as
// the design's own export did: the two can differ in the last bit, and every
// number in the checked-in file is that export's, digit for digit.
const length = (r) => round(r * (1 / 0.75));
const circle = (c, r) => ({ cx: round(toMark(c).x), cy: round(toMark(c).y), r: length(r) });
/** A circle as path data (two arcs), to cut out of the dome. */
const hole = (c, r) => {
  const R = num(length(r));
  const D = num(length(2 * r));
  return `M${point(V(c.x - r, c.y))}a${R} ${R} 0 1 0 ${D} 0a${R} ${R} 0 1 0 -${D} 0Z`;
};
const domePath = (segs) => `M${point(segs[0][0])}${segs.slice(1).map((s) => `C${s.map(point).join(" ")}`).join("")}Z`;

/**
 * A built hatchling as OctoHatchling draws it: the arms, then the dome as one
 * even-odd path (with the eyes cut out of it, or the hollow face's inner dome
 * cut out and its eyes drawn inside), then its circles (the dot, or the
 * hollow face's eyes). All of it is one ink.
 */
export function faceGeometry(fig) {
  let dome = domePath(domeSegs(fig.dome));
  const circles = [];
  if (fig.hollow) {
    dome += domePath(domeSegs({ ...fig.dome, ...fig.hollow }));
    circles.push(...fig.eyes.map((e) => circle(e, e.r * fig.hollow.eyeK)));
  } else {
    dome += fig.eyes.map((e) => hole(e, e.r)).join("");
  }
  if (fig.dot) circles.push(circle(fig.dot, fig.dot.r));
  return {
    paths: [...fig.arms.map((a) => ({ d: splinePath(a.ring, point) })), { d: dome, fillRule: "evenodd" }],
    circles,
  };
}
