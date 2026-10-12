// Small numeric helpers shared by every Cub module. All pure, no state.
// Ported 1:1 from the owner-approved prototype (not in this repo).

export type V3 = [number, number, number];

export const clamp = (a: number, v: number, b: number): number => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function sstep(a: number, b: number, x: number): number {
  const t = clamp(0, (x - a) / (b - a), 1);
  return t * t * (3 - 2 * t);
}

export function smoother(x: number): number {
  x = clamp(0, x, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const madd = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export function norm(a: V3): V3 {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function rotAxis(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const kd = dot(k, v);
  return [
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ];
}

/** Integer hash to [0, 1). */
export function hh(n: number): number {
  n = Math.imul(n ^ 61 ^ (n >>> 16), 9);
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

/** 1D value noise. */
export function n1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hh(Math.imul(i, 7919) + Math.imul(seed, 104729));
  const b = hh(Math.imul(i + 1, 7919) + Math.imul(seed, 104729));
  return a + (b - a) * u;
}

/** Three-octave fractal noise in [-1, 1]. */
export const fbm = (x: number, seed: number): number =>
  (n1(x, seed) * 0.62 + n1(x * 2.07 + 5.3, seed + 11) * 0.28 + n1(x * 4.3 + 1.7, seed + 23) * 0.1) * 2 - 1;

export const wrapPi = (a: number): number => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
/** Gaussian bump. */
export const gb = (s: number, m: number, w: number): number => Math.exp(-(((s - m) / w) ** 2));
/** Cubic ease-out. */
export function eo(x: number): number {
  x = clamp(0, x, 1);
  return 1 - (1 - x) ** 3;
}
export const bump = (x: number, c: number, w: number): number => Math.exp(-(((x - c) / w) ** 2));

/** Piecewise smoother keyframes [[x, y], ...]; zero outside the range. */
export function keyAt(keys: readonly (readonly [number, number])[], x: number): number {
  if (x <= keys[0][0] || x >= keys[keys.length - 1][0]) return 0;
  let i = 0;
  while (x > keys[i + 1][0]) i++;
  return lerp(keys[i][1], keys[i + 1][1], smoother((x - keys[i][0]) / (keys[i + 1][0] - keys[i][0])));
}

type NumKey<T> = { [P in keyof T]: T[P] extends number ? P : never }[keyof T] & string;

/** A damped spring on two numeric fields of an object (value and velocity). */
export function spring<T extends object>(
  o: T,
  k: NumKey<T>,
  v: NumKey<T>,
  target: number,
  period: number,
  zeta: number,
  dt: number,
): void {
  const w = (2 * Math.PI) / period;
  const rec = o as unknown as Record<string, number>;
  rec[v] += (w * w * (target - rec[k]) - 2 * zeta * w * rec[v]) * dt;
  rec[k] += rec[v] * dt;
}
