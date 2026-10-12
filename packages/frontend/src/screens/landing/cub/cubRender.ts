// Draws one frame: builds the rig, fills the uniforms and runs the two GL
// passes (G-buffer, then the pen composite), scissored to Cub's bounding box.
// Ported from the owner-approved prototype (not in this repo).

import { K, LWI, MAXR } from "./cubConfig";
import { attNow, CAM, poiXY } from "./cubAttention";
import { build } from "./cubBuild";
import { glRect, proj, unproj, vpForBox } from "./cubCamera";
import { isStill, motionOK } from "./cubClock";
import { eyeOff, eyeSim, lidAt, offFor, shadePlace } from "./cubEyes";
import type { CubGl } from "./cubGl";
import { clamp } from "./cubMath";
import { reachArmOf } from "./cubReach";
import type { Cub } from "./cubState";

export type RenderResult = "ok" | "skipped" | "gbuffer-incomplete";

/** Renders Cub at sim time t into canvas (sized to c.CVR). */
export function renderFrame(c: Cub, R: CubGl, canvas: HTMLCanvasElement, t: number): RenderResult {
  if (!c.L || !c.G || !c.Sidle) return "skipped";
  const t0 = performance.now();
  build(c, t);
  const L = c.L;
  const G = c.G;
  const { OC, EYEG, EYE, LOOK, cam, SPD, EA, EB, EC, ANC, ANCH, INFO, UF, UM, UMB, MOUTH, theme } = c;
  const { DPR, HV, CD } = cam;
  const u = OC.u;
  const live = motionOK(c);
  const still = isStill(c);
  const calm = !live && !still;
  if (still) eyeSim(c, t);
  const off = calm ? offFor(c, poiXY(c, "octoMessage", 0.3) || CAM) : eyeOff(c, t);
  const lid = (c.LIDNOW = calm ? 0.72 : lidAt(c, t, live));
  const dil = calm ? 0 : Math.max(EYE.cam, attNow(c, t).e, live ? LOOK.e : 0);
  for (let k = 0; k < 2; k++) {
    const e = EYEG[k];
    const wx = Math.hypot(e.ax * e.sq, e.ay);
    const wy = Math.hypot(e.ay * e.sq, e.ax);
    EA.set([e.x * DPR, HV - e.y * DPR, e.R * DPR, e.vis], k * 4);
    EB.set([e.ax, -e.ay, e.sq, lid], k * 4);
    EC.set([off[0] * wx * (1 - 0.3 * dil), -off[1] * wy * (1 - 0.3 * dil), e.roll, dil], k * 4);
  }
  shadePlace(c, u, theme.dark);
  let minx = 1e9;
  let miny = 1e9;
  let maxx = -1e9;
  let maxy = -1e9;
  let zmin = 1e9;
  let zmax = -1e9;
  for (let row = 0; row < 9; row++)
    for (let i = 0; i < K; i++) {
      const o = (row * K * 3 + i * 3) * 4;
      const z = SPD[o + 2];
      const s = proj(cam, [SPD[o], SPD[o + 1], z]);
      const m = SPD[o + 3] * s[2] * 1.25 + 12;
      minx = Math.min(minx, s[0] - m);
      maxx = Math.max(maxx, s[0] + m);
      miny = Math.min(miny, s[1] - m);
      maxy = Math.max(maxy, s[1] + m);
      zmin = Math.min(zmin, z);
      zmax = Math.max(zmax, z);
    }
  zmin -= u;
  zmax += u;
  c.BB = [minx, miny, maxx, maxy];
  const k = CD / (CD - -0.3 * u);
  ANC.set([clamp(4, u * 0.1 * k, 6), k, 0.8, 1]);
  const ob = proj(cam, unproj(cam, OC.bx, G.edgeY, 0));
  ANCH.set([ob[0] * DPR, HV - ob[1] * DPR, clamp(3.2, u * 0.068 * k, 5), 1]);
  const noCr = c.LASTACT.wR > 0 ? 2 + reachArmOf(c) : -1;
  for (let r = 0; r < c.ROWS; r++) INFO.set([clamp(0.85, Math.sqrt(k), 1.1), r + 1 === noCr ? 1 : 0, L.mobile && r <= 8 ? 1 : 0, 0.16 * u * k], (r + 1) * 4);
  const CVR = c.CVR;
  const ox = CVR.x;
  const oy = HV - (CVR.y + CVR.h);
  const cw = canvas.width;
  const ch = canvas.height;
  const sx = clamp(ox, Math.floor(minx * DPR), ox + cw);
  const sy = clamp(oy, Math.floor(HV - maxy * DPR), oy + ch);
  const sw = clamp(ox, Math.ceil(maxx * DPR), ox + cw) - sx;
  const shh = clamp(oy, Math.ceil(HV - miny * DPR), oy + ch) - sy;
  const gl = R.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, cw, ch);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (sw > 0 && shh > 0) {
    if (!R.ensureFbo(sw, shh)) return "gbuffer-incomplete";
    vpForBox(cam, sx, sy, sw, shh, cam.WV, cam.HV);
    const seed = 0;
    const z8 = R.depthFmt === "u8";
    const zk = z8 ? 1 / Math.max(1, zmax - zmin) : 1;
    const z0 = z8 ? zmin : 0;
    const ug = R.ug;
    const uc = R.uc;
    gl.bindTexture(gl.TEXTURE_2D, R.spineTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, K * 3, MAXR, gl.RGBA, gl.FLOAT, SPD);
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.fbo);
    gl.viewport(0, 0, sw, shh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, sw, shh);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(R.PG);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, R.spineTex);
    gl.uniform1i(ug.uSpine, 0);
    gl.uniformMatrix4fv(ug.uVP, false, cam.VPB);
    gl.uniform4fv(ug.uTube, c.TUBE);
    gl.uniform4fv(ug.uTube2, c.TUBE2);
    gl.uniform4fv(ug.uAnc, ANC);
    gl.uniform1f(ug.uZ0, z0);
    gl.uniform1f(ug.uZk, zk);
    gl.uniform1f(ug.uDark, theme.dark);
    gl.uniform4f(ug.uEye, c.EYE_AZN, c.EYE_AMP[0], c.EYE_AMP[1], OC.eb);
    gl.bindVertexArray(R.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, R.nIdx, gl.UNSIGNED_SHORT, 0, c.ROWS);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.DEPTH_TEST);
    gl.scissor(sx - ox, sy - oy, sw, shh);
    gl.useProgram(R.PC);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, R.tA);
    gl.uniform1i(uc.uA, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, R.tB);
    gl.uniform1i(uc.uB, 1);
    const lw = c.o.lw;
    gl.uniform4fv(uc.uInfo, INFO);
    gl.uniform4fv(uc.uAnch, ANCH);
    gl.uniform1f(uc.uDpr, DPR);
    gl.uniform1f(uc.uLW, L.mobile ? lw * 0.92 : lw);
    gl.uniform1f(uc.uLWi, L.mobile ? LWI * 0.95 : LWI);
    gl.uniform1f(uc.uSeed, seed);
    gl.uniform1f(uc.uZinv, 1 / zk);
    gl.uniform2f(uc.uOrg, sx, sy);
    gl.uniform2f(uc.uSz, sw, shh);
    gl.uniform2f(uc.uOff, ox, oy);
    gl.uniform4fv(uc.uMainR, glRect(cam, L.main));
    if (import.meta.env.DEV) gl.uniform1f(uc.uDbg, c.o.shaderView);
    gl.uniform3fv(uc.uInk, theme.ink);
    gl.uniform3fv(uc.uPaper, theme.paper);
    gl.uniform3fv(uc.uSurf, theme.surf);
    gl.uniform4fv(uc.uEyeA, EA);
    gl.uniform4fv(uc.uEyeB, EB);
    gl.uniform4fv(uc.uEyeC, EC);
    {
      const smile = calm ? 0 : c.LASTBEAT.smile;
      const bk = calm ? { hap: 0, pop: 0 } : c.BLK_NOW;
      UF.set([bk.hap, smile, bk.pop, 0]);
      UM.set([MOUTH.x * DPR, HV - MOUTH.y * DPR, MOUTH.s * DPR, c.o.eyes ? smile * MOUTH.vis : 0]);
      UMB.set([MOUTH.ax, MOUTH.ay, MOUTH.sq, 0]);
      gl.uniform4fv(uc.uFace, UF);
      gl.uniform4fv(uc.uMouth, UM);
      gl.uniform4fv(uc.uMouthB, UMB);
    }
    gl.uniform4fv(uc.uShd, c.SHD);
    gl.uniform2fv(uc.uShdT, c.SHDT);
    gl.uniform1f(uc.uDark, theme.dark);
    gl.uniform4f(uc.uEdge, HV - (G.edgeY + 0.5) * DPR, (G.wx0 + 10) * DPR, (G.wx1 - 10) * DPR, 0);
    gl.uniform4f(uc.uCrown, c.CROWN[0] * DPR, HV - (c.CROWN[1] + 0.12 * u) * DPR, 0.7 * u * DPR, 0.32 * u * DPR);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }
  const P = c.PERF;
  P.frames++;
  P.js += performance.now() - t0;
  P.rows = c.ROWS;
  P.box = [sw, shh];
  P.canvas = [cw, ch];
  return "ok";
}
