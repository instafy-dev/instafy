// Developer hooks, created only when options.debug is set: the keep-out /
// hit-circle overlay, a detailed state dump, the keep-out pixel audit, a
// render bench and the fallback sprite capture. Nothing here is attached to
// window; the host reaches it through handle.dev.
// Ported from the owner-approved prototype (not in this repo).

import { gazeWant } from "./cubAttention";
import { demoAt, motionOK } from "./cubClock";
import { DEFAULT_THEME_DARK, DEFAULT_THEME_LIGHT } from "./cubConfig";
import { eyeOff } from "./cubEyes";
import { reachArmOf } from "./cubReach";
import type { Cub } from "./cubState";
import type { CubDevHooks, CubFallbackSprite, CubPerchMode, CubRect, CubTheme } from "./cubTypes";

export interface DevDeps {
  host: HTMLElement;
  glCanvas: HTMLCanvasElement;
  gl: () => WebGL2RenderingContext | null;
  /** Renders one frame at sim time t (no loop). */
  render: (t: number) => void;
  setTheme: (t: CubTheme) => void;
  getTheme: () => CubTheme;
  overlay: (on: boolean) => void;
}

/** Draws keep-outs, the hang line, hit circles, the pointer, eyes, gaze and the canvas rect. */
export function drawDebug(c: Cub, cv: HTMLCanvasElement): void {
  const { W, H } = c.cam;
  if (cv.width !== W || cv.height !== H) {
    cv.width = W;
    cv.height = H;
    cv.style.width = W + "px";
    cv.style.height = H + "px";
  }
  const x = cv.getContext("2d");
  const G = c.G;
  const S = c.Sidle;
  if (!x || !G || !S) return;
  x.clearRect(0, 0, W, H);
  x.lineWidth = 1;
  x.strokeStyle = "#E5484D";
  x.setLineDash([4, 3]);
  S.rects.forEach((r) => x.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h));
  x.setLineDash([]);
  x.beginPath();
  x.moveTo(G.wx0, G.deep);
  x.lineTo(G.wx1, G.deep);
  x.stroke();
  x.strokeStyle = "#0091FF";
  x.fillStyle = "#0091FF";
  x.globalAlpha = 0.55;
  const HIT = c.HIT;
  for (let i = 0; i < c.NHIT; i++) {
    x.beginPath();
    x.arc(HIT[i * 3], HIT[i * 3 + 1], HIT[i * 3 + 2], 0, 6.283);
    x.stroke();
  }
  x.globalAlpha = 1;
  const PT = c.PT;
  if (PT.in) {
    x.setLineDash([2, 4]);
    x.beginPath();
    x.arc(PT.x, PT.y, 8, 0, 6.283);
    x.stroke();
    x.setLineDash([]);
  }
  x.beginPath();
  x.arc(c.BODYC[0], c.BODYC[1], 4, 0, 6.283);
  x.fill();
  c.EYEG.forEach((e) => {
    if (e.vis > 0) {
      x.beginPath();
      x.arc(e.x, e.y, e.R, 0, 6.283);
      x.stroke();
    }
  });
  const g = motionOK(c) ? gazeWant(c, c.simClock) : null;
  if (g && !g[2]) {
    x.setLineDash([3, 3]);
    x.beginPath();
    x.moveTo(c.EYEG[0].x, c.EYEG[0].y);
    x.lineTo(g[0], g[1]);
    x.stroke();
    x.setLineDash([]);
  }
  if (c.CUR.arm >= 0) {
    x.beginPath();
    x.arc(c.CUR.x, c.CUR.y, 5, 0, 6.283);
    x.stroke();
  }
  const { CVR } = c;
  const DPR = c.cam.DPR;
  x.strokeStyle = "rgba(128,128,128,.5)";
  x.strokeRect(CVR.x / DPR + 0.5, CVR.y / DPR + 0.5, CVR.w / DPR - 1, CVR.h / DPR - 1);
  x.font = "11px ui-monospace, monospace";
  const A = c.LASTACT;
  x.fillText(
    `${c.OC.mode}  reach ${(A.wR || 0).toFixed(2)}  curious ${(A.curW || 0).toFixed(2)} arm ${c.CUR.arm} engaged ${c.CUR.engaged ? 1 : 0}  flinch ${(A.f || 0).toFixed(2)}  gaze ${g ? (g[2] ? "you" : "pt") : "-"}`,
    CVR.x / DPR + 6,
    CVR.y / DPR + 14,
  );
}

export function createDevHooks(c: Cub, d: DevDeps): CubDevHooks {
  const state = (): Record<string, unknown> => ({
    arms: c.ARMDBG.slice(),
    simClock: c.simClock,
    helloShift: c.helloShift,
    u: c.OC.u,
    bx: c.OC.bx,
    mode: c.OC.mode,
    shift: c.SHIFT.x,
    shiftT: c.SHIFT.target,
    dpr: c.cam.DPR,
    canvas: [d.glCanvas.width, d.glCanvas.height],
    box: c.PERF.box,
    act: c.LASTACT,
    cur: { arm: c.CUR.arm, w: c.CUR.w, near: c.CUR.near, engaged: c.CUR.engaged },
    body: c.BODYC.slice(),
    head: c.HEADC.slice(),
    eyes: c.EYEG.map((e) => ({ x: +e.x.toFixed(1), y: +e.y.toFixed(1), R: +e.R.toFixed(1), vis: e.vis, f: +e.f.toFixed(2), clr: +e.clr.toFixed(2), on: e.on, sw: +e.sw.toFixed(3) })),
    lid: +c.LIDNOW.toFixed(3),
    hardOff: c.EYE.hardOff,
    amp: c.EYE_AMP.map((v) => +(v / c.OC.eb).toFixed(3)),
    az: +c.EYE_AZN.toFixed(3),
    psiT: +(c.OC.psi0 + (c.LASTACT.psi || 0)).toFixed(3),
    gaze: motionOK(c) ? gazeWant(c, c.simClock) : null,
    eyeOff: eyeOff(c, c.simClock),
    roles: c.OC.roles,
    nhit: c.NHIT,
    demo: demoAt(c),
    glOK: c.glOK,
    raf: !!c.raf,
    idle: !!c.idleTO,
    ink: c.ink.sets.map((b) => ({
      age: +(c.simClock - b.t).toFixed(2),
      st: b.st,
      fade: b.fadeT != null,
      drops: b.drops.map((q) => [+q.tx.toFixed(1), +q.ty.toFixed(1), +q.r.toFixed(1)]),
    })),
    inkDropped: c.ink.dropped,
    shade: c.SHD[3] > 0 ? [+(c.SHD[0] / c.cam.DPR).toFixed(1), +((c.cam.HV - c.SHD[1]) / c.cam.DPR).toFixed(1)] : null,
    spines: c.OC.parm ? c.OC.parm.map((o) => Array.from(o.X, (x, j) => [+x.toFixed(1), +o.Y[j].toFixed(1)])) : null,
    reachArm: c.OC.roles ? reachArmOf(c) : -1,
    route: c.REACHDBG ? { pts: c.REACHDBG.pts.map((q) => [+q[0].toFixed(1), +q[1].toFixed(1)]), T: c.REACHDBG.T, rho: c.REACHDBG.rho, xA: c.REACHDBG.xA, rx: c.REACHDBG.rx } : null,
    layout: c.L ? { sig: c.L.sig, mobile: c.L.mobile } : null,
  });

  const audit: CubDevHooks["audit"] = (T = 20, step = 0.25, td0) => {
    const L = c.L;
    const gl = d.gl();
    const hits: Record<string, { frames: number; maxpx: number; t: number[] }> = {};
    if (!L || !gl) return { frames: 0, hits };
    const rs: [string, CubRect, boolean][] = [
      ...L.text.map((r, i) => [`text${i}`, r, false] as [string, CubRect, boolean]),
      ...(L.cta ? [["cta", L.cta, false] as [string, CubRect, boolean]] : []),
      ...L.chipRects.map((r, i) => [`chip${i}`, r, false] as [string, CubRect, boolean]),
      ...L.coins.map((r, i) => [`coin${i}`, r, i === L.octoIdx] as [string, CubRect, boolean]),
      ...L.chrome.map((r, i) => [`chrome${i}`, r, false] as [string, CubRect, boolean]),
      ...L.keep.filter((r) => !L.text.includes(r) && r !== L.cta && !L.chipRects.includes(r)).map((r, i) => [`keep${i}`, r, false] as [string, CubRect, boolean]),
      ["title", L.ctitleRow, false],
      ["kimMsg", L.kim, false],
    ];
    const cv = d.glCanvas;
    const cw = cv.width;
    const ch = cv.height;
    const px = new Uint8Array(cw * ch * 4);
    const DPR = c.cam.DPR;
    const CVR = c.CVR;
    let frames = 0;
    const t0 = c.simClock;
    const oc = L.octoCoin;
    const ocx = (oc.x + oc.w / 2) * DPR - CVR.x;
    const ocy = (oc.y + oc.h / 2) * DPR - CVR.y;
    const orr = 0.37 * oc.w * DPR;
    for (let t = t0 + step; t <= t0 + T + 1e-6; t += step) {
      // With td0 the turn is replayed from td0 alongside (the frames follow the turn's choreography).
      if (td0 != null) c.turnOverride = { td: td0 + (t - t0), live: true };
      d.render(t);
      frames++;
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (const [nm, r, logo] of rs) {
        const x0 = Math.max(0, Math.floor(r.x * DPR - CVR.x));
        const x1 = Math.min(cw, Math.ceil((r.x + r.w) * DPR - CVR.x));
        const y0 = Math.max(0, Math.floor(r.y * DPR - CVR.y));
        const y1 = Math.min(ch, Math.ceil((r.y + r.h) * DPR - CVR.y));
        let n = 0;
        for (let y = y0; y < y1; y++) {
          const row = (ch - 1 - y) * cw;
          for (let x = x0; x < x1; x++) if (px[(row + x) * 4 + 3] > 25 && (!logo || Math.hypot(x + 0.5 - ocx, y + 0.5 - ocy) < orr)) n++;
        }
        if (n) {
          const h = hits[nm] || (hits[nm] = { frames: 0, maxpx: 0, t: [] });
          h.frames++;
          h.maxpx = Math.max(h.maxpx, n);
          if (h.t.length < 12) h.t.push(+(t - t0).toFixed(2));
        }
      }
    }
    c.turnOverride = null;
    d.render(c.simClock);
    return { frames, hits };
  };

  const bench = (n: number, t?: number) => {
    const gl = d.gl();
    const px = new Uint8Array(4);
    const b = t == null ? c.simClock : t;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      d.render(b + i / 60);
      gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    return (performance.now() - t0) / Math.max(1, n);
  };

  const fbCapture = async (t = 1.6): Promise<CubFallbackSprite & { mode: CubPerchMode }> => {
    const gl = d.gl();
    const L = c.L;
    if (!gl || !L) throw new Error("no renderer");
    const cv = d.glCanvas;
    const view0 = c.o.shaderView;
    const theme0 = d.getTheme();
    const grab = (mode: number) => {
      c.o.shaderView = mode;
      d.render(t);
      const cw = cv.width;
      const ch = cv.height;
      const px = new Uint8Array(cw * ch * 4);
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return { px, cw, ch };
    };
    d.setTheme({ ...DEFAULT_THEME_LIGHT, crew: [...DEFAULT_THEME_LIGHT.crew] });
    const ink = grab(5);
    const cov = grab(6);
    d.setTheme({ ...DEFAULT_THEME_DARK, crew: [...DEFAULT_THEME_DARK.crew] });
    const inkD = grab(5);
    c.o.shaderView = view0;
    d.setTheme(theme0);
    d.render(c.simClock);
    const bb = c.BB!;
    const DPR = c.cam.DPR;
    const CVR = c.CVR;
    const x0 = Math.max(0, Math.floor(bb[0] * DPR - CVR.x));
    const y0 = Math.max(0, Math.floor(bb[1] * DPR - CVR.y));
    const x1 = Math.min(ink.cw, Math.ceil(bb[2] * DPR - CVR.x));
    const y1 = Math.min(ink.ch, Math.ceil(bb[3] * DPR - CVR.y));
    const w = x1 - x0;
    const h = y1 - y0;
    const enc = (g: { px: Uint8Array; cw: number; ch: number }) => {
      const cc = document.createElement("canvas");
      cc.width = w;
      cc.height = h;
      const x = cc.getContext("2d")!;
      const id = x.createImageData(w, h);
      for (let y = 0; y < h; y++)
        for (let i = 0; i < w; i++) {
          const s = ((g.ch - 1 - (y + y0)) * g.cw + (i + x0)) * 4;
          const dd = (y * w + i) * 4;
          id.data[dd] = id.data[dd + 1] = id.data[dd + 2] = 0;
          id.data[dd + 3] = g.px[s + 3];
        }
      x.putImageData(id, 0, 0);
      return cc.toDataURL("image/webp", 0.82);
    };
    const sc = 1 / DPR;
    return {
      mode: c.OC.mode,
      ink: enc(ink),
      inkDark: enc(inkD),
      cov: enc(cov),
      w: w * sc,
      h: h * sc,
      u: c.OC.u,
      bx: c.OC.bx - (x0 + CVR.x) / DPR,
      ey: L.win.y - (y0 + CVR.y) / DPR,
    };
  };

  return {
    state,
    perf: c.PERF,
    audit,
    bench,
    fbCapture,
    setOverlay: (on) => d.overlay(on),
    setShaderView: (mode) => {
      c.o.shaderView = mode;
      d.render(c.simClock);
    },
    renderAt: (t, td) => {
      c.turnOverride = td === undefined ? null : td == null ? { td: 15, live: false } : { td, live: true };
      try {
        d.render(t);
      } finally {
        c.turnOverride = null;
      }
    },
    bodyXY: () => {
      const r = d.host.getBoundingClientRect();
      return [c.BODYC[0] + r.left, c.BODYC[1] + r.top];
    },
    replayHello: () => {
      c.helloShift = c.simClock + 0.3 - c.o.timeline.hello.t;
      c.helloPinned = true;
      c.kick();
    },
  };
}
