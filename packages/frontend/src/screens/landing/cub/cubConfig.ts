// Fixed tuning of Cub's rig, eyes, arms and pen. These are the approved
// prototype's numbers (the owner-approved prototype is not in this repo); change them only together
// with a fresh fidelity check against the prototype stills.
// Everything here is immutable: precomputed tables are frozen typed arrays
// that no module writes to.

import octoMarkGeometry from "../../../assets/octo-mark.geometry.json";
import { norm, sstep, type V3 } from "./cubMath";

/** Spine joints per tube. */
export const K = 40;
/** Maximum tube rows (body + 8 arms + 8 webs, plus one scratch row). */
export const MAXR = 24;
/** Tube mesh resolution (along x around). */
export const NS = 96;
export const NR = 22;
/** Joint spacing exponent: joints bunch toward the tip. */
export const GP = 1.7;
export const sOf = (x: number): number => 1 - Math.pow(1 - x, GP);

/** Arc-length parameter of every joint. */
export const SS: Float64Array = (() => {
  const a = new Float64Array(K);
  for (let i = 0; i < K; i++) a[i] = sOf(i / (K - 1));
  return a;
})();
const firstJoint = (s: number): number => {
  let j = 0;
  while (SS[j] < s) j++;
  return j;
};

export const REST_H = 0.28;
export const SEAT_LOW = Math.max(0, 0.28 - REST_H);
export const BODY_L = 1.9;
export const EYE_AZ = { desk: 0.58, mobile: 0.5 } as const;
export const EYE_R = { desk: 0.31, mobile: 0.27 } as const;
export const EYE_SMALL = 4;
export const EB_AMP = 0.035;
export const EB_W = 0.13;
export const EYE_UP = 0.78 + 0.6 * SEAT_LOW;
export const EB_S = EYE_UP / BODY_L;
export const HEAD_A = 0.5;
export const HEAD_B = 0.86;
export const HEAD_F = 0.14;
export const headF = (s: number): number => sstep(0.03, 0.1, s) * (1 - sstep(HEAD_A, HEAD_B, s));
export const ARM_R0 = 0.2;

export const BALL = { dc: 0.98, ry: 0.92, rx: 0.84, base: 0.46, cap: 0.13, nLo: 2.7, nHi: 2.15 } as const;
export const ROOT_FL: Readonly<Record<string, number>> = { dangle: 0.28, grip: 0.28 };
export const GRIP_A0 = 1.62;
export const GRIP_B = 0.22;
/** Extra keep-out margin around the avatar coins in the corner perch. */
export const COIN_M = 10;
export const REST_L = 1.15;
export const DRAPE_IN = 0.4;
export const DRAPE_L = 0.45;
export const DANGLE_L = 1.0;
export const GRIP_L = 0.95;
export const EXP_L = 1.75;
export const PEEK_ON = true;
export const PEEK_OUT = -0.12;
/** Room (in u) the peek's curl needs right of the corner; a narrower page margin moves the peek in. */
export const PEEK_ROOM = 0.45;
export const PEEK_L = 0.62;
export const PEEK_UP = 1.35;
export const PEEK_C = 1.7;
export const PEEK_RUN = 1.3;

export const NA: V3 = norm([0, 1, Math.tan(0.5)]);
export const REACH_D = 0.7;
export const TILT = 0.36;
export interface BodyPose {
  m?: number;
  lsc?: number;
  psi?: number;
  roll?: number;
  lift?: number;
  tilt?: number;
}
export const REST_B: Readonly<Required<BodyPose>> = { m: 1, lsc: 1, psi: 0, roll: 0, lift: 0, tilt: TILT };

export const ROLE_ANG = {
  corner: 0.15,
  dangle: 0.9,
  grip: 1.65,
  explore: 2.4,
  rest: 3.15,
  over: 3.95,
  curl: 4.75,
  edgeB: 5.5,
} as const;
export type ArmRole = keyof typeof ROLE_ANG;
export const ROLE_N = Object.keys(ROLE_ANG) as ArmRole[];

export const SUCK0: V3 = norm([0, -0.6, 0.8]);
export const GN = 1.7725;

export const REACH_MIN = 0.65;
export const REACH_ARCH = 0.35;
export const REACH_PHI = 3;
/** Px between the reach tip and the coin top: while arriving, while holding, and the extra dip of a tap. */
export const REACH_GAP = 6.5;
export const HOLD_GAP = 5;
export const TAP_LAND = 0.5;

export const CUR_S = 0.55;
export const CUR_ROT = 1.4;
export const CUR_LIFT = [0.25, 0.45] as const;
export const CUR_OPEN = 0.15;
export const CUR_VM = 40;
export const CUR_QM = 2.6;
export const CUR_J0 = firstJoint(CUR_S);
export const CUR_JQ = firstJoint(0.66);
export const CUR_JQ1 = (() => {
  let j = CUR_JQ;
  while (SS[j] < 0.93) j++;
  return j;
})();
export const CUR_J35 = firstJoint(0.35);

export const MORPH_LEAD = 0.12;
export const MORPH_S = 0.6;
export const MORPH_W = [0.3, 0.15] as const;
export const MORPH_J = firstJoint(MORPH_S);
export const FLK_J = firstJoint(0.85);

export const LOOK_PSI = 0.2;

export const CLR_ON = 1.6;
export const CLR_OFF = 0.3;
export const CLR_STILL = 1;
export const EYE_DWELL = 0.5;
export const EYE_HW = 0.85;
export const EYE_PAD = 2;
export const EYE_AZ_FRONT = 0.6;

/** Head hull sampling for eye visibility. */
export const HAZ = 32;
export const HCAP = 0.1;
export const HSN: Float64Array = Float64Array.from({ length: HAZ }, (_, j) => Math.sin((j / HAZ) * 2 * Math.PI));
export const HCS: Float64Array = Float64Array.from({ length: HAZ }, (_, j) => Math.cos((j / HAZ) * 2 * Math.PI));
export const HSS: readonly number[] = (() => {
  const a: number[] = [];
  for (let k = 0; k <= 20; k++) a.push(0.03 + (EB_S + 0.26 - 0.03) * (k / 20));
  for (let s = EB_S + 0.34; s < 0.98; s += 0.1) a.push(s);
  a.push(0.985);
  return a;
})();

/** Blink envelope shapes: [in, hold, out] seconds. */
export const BLINK = [0.045, 0.05, 0.065] as const;
export const SQZ = [0.05, 0.44, 0.07] as const;
export const HAPPY = [0.06, 0.5, 0.07] as const;
export const SOFT = [0.06, 0.4, 0.07] as const;

export const JIG_HELLO: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.13, -0.07],
  [0.33, 0.085],
  [0.56, -0.032],
  [0.74, 0.012],
  [0.9, 0],
];
export const JIG_BOOP: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.09, -0.1],
  [0.28, 0.095],
  [0.46, -0.045],
  [0.62, 0.02],
  [0.78, 0],
];
export const YAW_R = 0.22;
export const WAVE0 = 0.95;

/** Below this perch size the shade ticks are skipped. */
export const CUB_U0 = 40;
export const SHD_S = 0.56;
export const SHD_SD = 0.7;
export const SHD_IN = 0.13;
export const SHD_SP = 6;

export const FOV = (30 * Math.PI) / 180;
/** Pen widths (silhouette, interior) in css px. */
export const LW_DEFAULT = 2.15;
export const LWI = 1.12;

/** The calm frame (reduced motion) is rendered at this sim time. */
export const STILL_T = 1.6;

/** The logo's four dot centres (left to right), the arc the crew ink lands in. */
export const INK_LOGO: readonly (readonly [number, number])[] = octoMarkGeometry.circles.map(
  (c) => [c.cx, c.cy] as const,
);

/** Theme defaults (the prototype's light tokens). */
export const DEFAULT_CREW_LIGHT = ["#FF3C9F", "#1B864B", "#FA5815", "#814AD0"] as const;
export const DEFAULT_CREW_DARK = ["#FF3C9F", "#3CA063", "#FA5815", "#A672FA"] as const;
export const DEFAULT_THEME_LIGHT = {
  mode: "light",
  paper: "#F8F8F6",
  surface: "#FFFFFF",
  pen: "#2A2E36",
  crew: DEFAULT_CREW_LIGHT,
} as const;
export const DEFAULT_THEME_DARK = {
  mode: "dark",
  paper: "#141414",
  surface: "#1D1D1D",
  pen: "#EFEBE2",
  crew: DEFAULT_CREW_DARK,
} as const;
