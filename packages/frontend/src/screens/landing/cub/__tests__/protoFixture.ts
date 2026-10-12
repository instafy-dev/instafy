// Rects, perch values, ink plans, gaze samples and fallback CSS captured from the approved prototype
// (the owner-approved prototype, not in this repo: still=1&t=1600, light, deviceScaleFactor 2) at 1440x900, 860x900 and 390x844.
import raw from "./fixtures/prototypeLayout.json";
import { build } from "../cubBuild";
import { inkSize } from "../cubInkLayer";
import { applyLayout } from "../cubLayout";
import { createCubState, resolveOptions, type Cub } from "../cubState";
import { PROTOTYPE_TIMELINE } from "../cubTimeline";
import type { CubAnchors, CubPerchMode } from "../cubTypes";

export interface ProtoCase {
  dpr: number;
  anchors: CubAnchors & { width: number; height: number };
  expect: {
    mode: CubPerchMode;
    u: number;
    bx: number;
    psi0: number;
    psiCam: number;
    azF: number;
    restOn: number[];
    reachSh: number;
    shMin: number;
    shMax: number;
    cvr: { x: number; y: number; w: number; h: number };
    inkR: { x: number; y: number; w: number; h: number };
    edgeY: number;
    floorY: number;
    deep: number;
    roles: string[];
    body: number[];
    head: number[];
    nhit: number;
    inkSide: number;
    plan: { sd: number; r: number; rs: number[]; pts: number[][]; near: boolean; lv: number; hk: number } | null;
    planDots: { sd: number; r: number; pts: number[][]; near: boolean } | null;
    gaze?: [number, number[] | null][];
    wander?: [number, number[] | null][];
    fallback: { left: string; top: string; width: string; height: string; fby: string; clip: string; u: number; bx: number; winY: number };
  };
}

export const PROTO = raw as unknown as Record<CubPerchMode, ProtoCase>;
export const MODES: CubPerchMode[] = ["corner", "header", "mobile"];

/** A CPU-only Cub laid out against a prototype case, as the prototype's still page (t = 1.6 s) had it. */
export function cubFor(mode: CubPerchMode, anchors?: CubAnchors): Cub {
  const fx = PROTO[mode];
  const c = createCubState(resolveOptions({ timeline: PROTOTYPE_TIMELINE, still: { t: 1.6, td: 1.6 } }));
  const a = anchors ?? fx.anchors;
  applyLayout(c, a, fx.anchors.width, fx.anchors.height, fx.dpr, true);
  c.built = true;
  inkSize(c);
  build(c, 1.6);
  return c;
}
