// The perspective camera Cub is drawn with, and the world <-> host px maps.
// The camera looks down -z from CD; one world unit is one css px at z = 0.

import { FOV } from "./cubConfig";
import type { V3 } from "./cubMath";
import type { Cam } from "./cubState";

export function camera(cam: Cam): void {
  const { W, H } = cam;
  cam.CD = H / 2 / Math.tan(FOV / 2);
  const CD = cam.CD;
  const f = 1 / Math.tan(FOV / 2);
  const a = W / H;
  const n = CD * 0.2;
  const fa = CD * 4;
  const P = [f / a, 0, 0, 0, 0, f, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, (2 * fa * n) / (n - fa), 0];
  const VP = cam.VP;
  for (let i = 0; i < 16; i++) VP[i] = P[i];
  VP[14] = P[14] + P[10] * -CD;
  VP[15] = P[15] + P[11] * -CD;
}

/** The view-projection restricted to a device-px box (sx, sy, sw, sh) of the full (fw, fh) viewport. */
export function vpForBox(cam: Cam, sx: number, sy: number, sw: number, sh: number, fw: number, fh: number): void {
  const ax = fw / sw;
  const bx = (fw - 2 * sx) / sw - 1;
  const ay = fh / sh;
  const by = (fh - 2 * sy) / sh - 1;
  const { VP, VPB } = cam;
  for (let c = 0; c < 4; c++) {
    const x = VP[c * 4];
    const y = VP[c * 4 + 1];
    const w = VP[c * 4 + 3];
    VPB[c * 4] = ax * x + bx * w;
    VPB[c * 4 + 1] = ay * y + by * w;
    VPB[c * 4 + 2] = VP[c * 4 + 2];
    VPB[c * 4 + 3] = w;
  }
}

/** World -> host css px, plus the perspective scale k. */
export function proj(cam: Cam, p: V3): V3 {
  const w = cam.CD - p[2];
  const k = cam.CD / w;
  return [cam.W / 2 + p[0] * k, cam.H / 2 - p[1] * k, k];
}

/** Host css px at depth z -> world. */
export function unproj(cam: Cam, x: number, y: number, z: number): V3 {
  const k = (cam.CD - z) / cam.CD;
  return [(x - cam.W / 2) * k, -(y - cam.H / 2) * k, z];
}

/** A host-px rect as a GL-space [x0, y0, x1, y1] in device px. */
export function glRect(cam: Cam, r: { x: number; y: number; w: number; h: number } | null): [number, number, number, number] {
  const { DPR, HV } = cam;
  return r ? [r.x * DPR, HV - (r.y + r.h) * DPR, (r.x + r.w) * DPR, HV - r.y * DPR] : [0, 0, 0, 0];
}
