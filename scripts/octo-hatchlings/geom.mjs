// Plane geometry for Octo's hatchlings: points, turtle-drawn centrelines,
// tapered arms and the baby dome. Everything is in tile units (64 = the whole
// AI tile) and every shape is filled, never stroked, like Octo's own mark.

export const V = (x, y) => ({ x, y });
export const add = (a, b) => V(a.x + b.x, a.y + b.y);
export const sub = (a, b) => V(a.x - b.x, a.y - b.y);
export const mul = (a, s) => V(a.x * s, a.y * s);
const len = (a) => Math.hypot(a.x, a.y);
export const norm = (a) => {
  const l = len(a) || 1;
  return V(a.x / l, a.y / l);
};

/** Rotates a point about a centre, in degrees (clockwise on screen). */
export function rotAbout(p, c, deg) {
  const a = (deg * Math.PI) / 180;
  const d = sub(p, c);
  return V(c.x + d.x * Math.cos(a) - d.y * Math.sin(a), c.y + d.x * Math.sin(a) + d.y * Math.cos(a));
}

/**
 * A centreline drawn like a turtle: a start point, a heading in degrees (0 is
 * right, 90 is down), then runs of { len, turn } that turn the heading by
 * `turn` degrees evenly over `len` units. Returns the points it passes.
 */
export function turtle(start, heading, runs, step = 0.25) {
  let p = { ...start };
  let h = heading;
  const pts = [{ ...p }];
  for (const { len: L, turn = 0 } of runs) {
    const n = Math.max(1, Math.round(L / step));
    const dh = turn / n;
    for (let i = 0; i < n; i += 1) {
      h += dh / 2;
      const a = (h * Math.PI) / 180;
      p = { x: p.x + Math.cos(a) * (L / n), y: p.y + Math.sin(a) * (L / n) };
      h += dh / 2;
      pts.push({ ...p });
    }
  }
  return pts;
}

/** Resamples a polyline evenly by arc length into n segments. */
function resample(points, n) {
  const acc = [0];
  for (let i = 1; i < points.length; i += 1) acc.push(acc[i - 1] + len(sub(points[i], points[i - 1])));
  const total = acc[acc.length - 1];
  const out = [];
  let j = 0;
  for (let i = 0; i <= n; i += 1) {
    const target = (total * i) / n;
    while (j < acc.length - 2 && acc[j + 1] < target) j += 1;
    const span = acc[j + 1] - acc[j] || 1;
    const t = (target - acc[j]) / span;
    out.push(V(points[j].x + (points[j + 1].x - points[j].x) * t, points[j].y + (points[j + 1].y - points[j].y) * t));
  }
  return out;
}

/**
 * A tapered arm's outline: the left side from the root, a round tip cap, the
 * right side back. Its width eases from w0 at the root to w1 at the tip, and
 * the root is closed by a straight line that the dome covers. Returns the
 * ring of points with the tip's centre and direction (a dot can fly off it).
 */
export function armRing(centre, { w0, w1, n = 14, cap = 5 }) {
  const pts = resample(centre, n);
  const tang = pts.map((p, i) => norm(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)])));
  const left = [];
  const right = [];
  pts.forEach((p, i) => {
    const s = i / (pts.length - 1);
    const e = 1 - (1 - s) * (1 - s);
    const w = w0 + (w1 - w0) * e;
    const nr = V(-tang[i].y, tang[i].x);
    left.push(add(p, mul(nr, w / 2)));
    right.push(sub(p, mul(nr, w / 2)));
  });
  const tip = pts[pts.length - 1];
  const dir = tang[tang.length - 1];
  const nr = V(-dir.y, dir.x);
  const tipCap = [];
  for (let k = 1; k < cap; k += 1) {
    const a = (Math.PI * k) / cap;
    tipCap.push(add(tip, add(mul(nr, (Math.cos(a) * w1) / 2), mul(dir, (Math.sin(a) * w1) / 2))));
  }
  return { ring: [...left, ...tipCap, ...right.reverse()], tip, dir };
}

/** The cubic segments of an open Catmull-Rom spline through pts (end tangents follow the end chords). */
function catmullRom(pts) {
  const m = pts.length;
  const P = (i) => (i < 0 ? sub(mul(pts[0], 2), pts[1]) : i >= m ? sub(mul(pts[m - 1], 2), pts[m - 2]) : pts[i]);
  const segs = [];
  for (let i = 0; i < m - 1; i += 1) {
    segs.push([P(i), add(P(i), mul(sub(P(i + 1), P(i - 1)), 1 / 6)), sub(P(i + 1), mul(sub(P(i + 2), P(i)), 1 / 6)), P(i + 1)]);
  }
  return segs;
}

/** A smooth closed outline through pts as path data (C, then S), closed by a straight line. */
export function splinePath(pts, fmt) {
  const segs = catmullRom(pts);
  let d = `M${fmt(segs[0][0])}C${fmt(segs[0][1])} ${fmt(segs[0][2])} ${fmt(segs[0][3])}`;
  for (let i = 1; i < segs.length; i += 1) d += `S${fmt(segs[i][2])} ${fmt(segs[i][3])}`;
  return `${d}Z`;
}

/**
 * The baby dome as four cubic segments (start point first): rounder and
 * taller than Octo's, (cx, ys) the centre of its shoulder line, rot in
 * degrees about it.
 */
export function domeSegs({ cx, ys, w, top, bot, rot = 0 }) {
  const h = w / 2;
  const raw = [
    [[-h, 0]],
    [[-h, -0.62 * top], [-0.283 * w, -top], [0, -top]],
    [[0.283 * w, -top], [h, -0.62 * top], [h, 0]],
    [[h, 0.64 * bot], [0.4 * w, bot], [0, bot]],
    [[-0.4 * w, bot], [-h, 0.64 * bot], [-h, 0]],
  ];
  const c = Math.cos((rot * Math.PI) / 180);
  const s = Math.sin((rot * Math.PI) / 180);
  const tr = ([x, y]) => V(cx + x * c - y * s, ys + x * s + y * c);
  return raw.map((seg) => seg.map(tr));
}
