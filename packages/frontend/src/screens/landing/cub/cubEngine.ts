// createCub(): mounts Cub into a host element and runs him.
//
// The engine owns everything it creates: a WebGL canvas sized to Cub's region,
// a Canvas2D ink layer, an optional debug overlay and the no-WebGL fallback,
// all appended to the host (which must be position: relative with
// overflow: hidden). It never touches document or window state beyond adding
// listeners; its status is mirrored as data attributes on the host
// (data-cub-gl, data-cub-calm, data-cub-hot, data-cub-mode) and through
// callbacks. destroy() releases every listener, observer, timer, frame and the
// WebGL context, so React StrictMode's mount -> unmount -> mount works on the
// same host. Missing WebGL2, a failed compile or a lost context never throw:
// onStatus("off", reason) fires and the fallback still shows.
// Ported from the owner-approved prototype (not in this repo): the loop,
// layout, observers and boot.

import { STILL_T } from "./cubConfig";
import { attNow, pulse } from "./cubAttention";
import { demoAt, demoMotion, fine, isStill, motionOK, noticeOK } from "./cubClock";
import { createDevHooks, drawDebug } from "./cubDebug";
import { CubFallbackLayer, fallbackPlacement } from "./cubFallback";
import { CubGl } from "./cubGl";
import { inkDispose, inkDraw, inkPause, inkRelayout, inkReset, inkSize, inkWarm } from "./cubInkLayer";
import { ctaGlance, hitAt, nearDist, poke, stepInteract, textAt } from "./cubInteract";
import { applyLayout, cubOnScreen } from "./cubLayout";
import { lerp } from "./cubMath";
import { renderFrame } from "./cubRender";
import { createCubState, hexRGB, resolveOptions, type Cub } from "./cubState";
import { HELLO_TAIL, helloShiftFor, pressOn, turnActive } from "./cubTimeline";
import type {
  CubAnchors,
  CubFallbackReason,
  CubFallbackSprites,
  CubGlStatus,
  CubHandle,
  CubOptions,
  CubPublicState,
  CubTheme,
  CubTurn,
} from "./cubTypes";

const FINE_QUERY = "(hover: hover) and (pointer: fine)";

function applyTheme(c: Cub, t: CubTheme): void {
  const th = c.theme;
  th.ink = hexRGB(t.pen, th.ink);
  th.paper = hexRGB(t.paper, th.paper);
  th.surf = hexRGB(t.surface, th.surf);
  th.dark = t.mode === "dark" ? 1 : 0;
  const crew = Array.from(t.crew).slice(0, 4);
  if (crew.length === 4 && crew.every((v) => /^#[0-9a-f]{6}$/i.test(v.trim()))) th.crew = crew.map((v) => v.trim());
  else if (import.meta.env.DEV) console.warn("Cub: theme.crew needs four #rrggbb colours; keeping the previous ink.", t.crew);
}

function layerCanvas(doc: Document, name: string, z: number): HTMLCanvasElement {
  const cv = doc.createElement("canvas");
  cv.setAttribute("aria-hidden", "true");
  cv.dataset.cubLayer = name;
  Object.assign(cv.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
    width: "0px",
    height: "0px",
    zIndex: String(z),
    pointerEvents: "none",
    display: "block",
  });
  cv.width = 0;
  cv.height = 0;
  return cv;
}

export function createCub(host: HTMLElement, options: CubOptions): CubHandle {
  const o = resolveOptions(options);
  const c = createCubState(o);
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  // Frames, timers and the clock all come from the host's own window (the
  // global one only stands in for a host whose document has no view).
  const view: Window = win ?? window;
  let themeIn: CubTheme = options.theme;
  applyTheme(c, themeIn);
  c.rmOn = !!options.reducedMotion;
  c.motionOn = options.motion ?? true;
  c.noticeOn = options.notice ?? true;
  c.turn = options.turn ?? { live: false };
  c.getTurnTime = options.getTurnTime ?? null;
  c.fineQ = win && typeof win.matchMedia === "function" ? win.matchMedia(FINE_QUERY) : null;
  let anchorsSrc = options.anchors;
  const ac = new AbortController();
  const sig = ac.signal;

  // --- layers ---
  const glCv = layerCanvas(doc, "gl", o.zIndex);
  const inkCv = layerCanvas(doc, "ink", o.zIndex);
  // Dev builds only: a production build drops the overlay and the dev hooks
  // (cubDebug.ts) from the engine chunk altogether.
  const debugOn = import.meta.env.DEV && o.debug;
  const dbgCv = debugOn ? layerCanvas(doc, "debug", o.zIndex + 5) : null;
  if (dbgCv) dbgCv.style.display = o.overlay ? "block" : "none";
  let overlay = o.overlay;
  const fbLayer = o.fallback ? new CubFallbackLayer(doc, o.zIndex) : null;
  host.append(glCv, inkCv);
  if (fbLayer) host.append(fbLayer.el);
  if (dbgCv) host.append(dbgCv);
  c.ink.cv = inkCv;

  // --- status ---
  let status: CubGlStatus = "wait";
  const setStatus = (s: CubGlStatus, reason?: CubFallbackReason) => {
    const changed = s !== status;
    status = s;
    host.dataset.cubGl = s;
    glCv.style.visibility = s === "off" ? "hidden" : "";
    inkCv.style.display = s === "off" ? "none" : "block";
    if (changed || reason) options.onStatus?.(s, reason);
  };
  host.dataset.cubGl = "wait";
  const setPress = (on: boolean) => {
    if (on === c.coinPressed) return;
    c.coinPressed = on;
    options.onCoinPress?.(on);
  };
  const setHot = (h: boolean) => {
    if (h === c.hot) return;
    c.hot = h;
    if (h) host.dataset.cubHot = "";
    else delete host.dataset.cubHot;
    options.onHotChange?.(h);
  };

  // --- GL ---
  let gl: WebGL2RenderingContext | null = null;
  let R: CubGl | null = null;
  if (!o.noGl) {
    try {
      gl = glCv.getContext("webgl2", {
        antialias: false,
        alpha: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: !!o.still,
      });
    } catch {
      gl = null;
    }
  }

  const resolveAnchors = (): CubAnchors | null => {
    try {
      return typeof anchorsSrc === "function" ? anchorsSrc() : anchorsSrc;
    } catch {
      return null;
    }
  };

  // A loader runs the first time the still is needed; nothing shows until it resolves.
  let fbSprites: CubFallbackSprites | null = typeof o.fallback === "function" ? null : o.fallback;
  let fbLoading = false;
  const fallbackArt = () => {
    if (!fbLayer) return;
    const L = c.L;
    if (!L || status !== "off") {
      fbLayer.hide();
      return;
    }
    const fb = fbSprites;
    if (!fb) {
      const load = o.fallback;
      if (typeof load === "function" && !fbLoading) {
        fbLoading = true;
        load()
          .then((sprites) => {
            if (c.destroyed) return;
            fbSprites = sprites;
            fallbackArt();
          })
          .catch(() => undefined);
      }
      fbLayer.hide();
      return;
    }
    const S = fb[c.OC.mode] || fb.corner;
    fbLayer.show(S, fallbackPlacement(S, c.OC.mode, c.OC.u, c.OC.bx, L.win.y), themeIn, L.main);
  };

  const sizeCanvas = () => {
    const CVR = c.CVR;
    const DPR = c.cam.DPR;
    if (glCv.width !== CVR.w || glCv.height !== CVR.h) {
      glCv.width = CVR.w;
      glCv.height = CVR.h;
    }
    Object.assign(glCv.style, { left: CVR.x / DPR + "px", top: CVR.y / DPR + "px", width: CVR.w / DPR + "px", height: CVR.h / DPR + "px" });
    inkSize(c);
  };

  // The host's size at the last layout: a frame that finds it changed lays
  // out again, so a resize the observer reported mid-storm never leaves a
  // stale perch behind (the observer stays quiet once its last size holds).
  let laidW = -1;
  let laidH = -1;
  const layout = (force: boolean): boolean => {
    const a = resolveAnchors();
    if (!a || !a.window || !a.panel) return false;
    const hr = host.getBoundingClientRect();
    const W = a.width ?? hr.width;
    const H = a.height ?? hr.height;
    if (!(W > 0 && H > 0)) return false;
    laidW = hr.width;
    laidH = hr.height;
    const G0 = c.G;
    const { mode, u, bx } = c.OC;
    const changed = applyLayout(c, a, W, H, (win && win.devicePixelRatio) || 1, force);
    if (!changed) return true;
    host.dataset.cubMode = c.OC.mode;
    // The same ledge and perch (a scenario swap): the ink on the wall stays.
    const G = c.G;
    const near = (p: number, q: number) => Math.abs(p - q) <= 1;
    const same =
      !!G0 && !!G && near(G.edgeY, G0.edgeY) && near(G.wx0, G0.wx0) && near(G.wx1, G0.wx1) && c.OC.mode === mode && near(c.OC.u, u) && near(c.OC.bx, bx);
    inkRelayout(c, same, c.simClock);
    inkWarm(c);
    sizeCanvas();
    if (status === "off") fallbackArt();
    return true;
  };

  const glReady = () => !!R && c.glOK && !c.glLost;

  const goOff = (reason: CubFallbackReason) => {
    c.glOK = false;
    if (c.raf) view.cancelAnimationFrame(c.raf);
    c.raf = 0;
    setPress(false);
    setHot(false);
    setStatus("off", reason);
    fallbackArt();
  };

  const render = (t: number) => {
    if (!R || !glReady()) return;
    if (c.relayoutSoon) {
      c.relayoutSoon = false;
      layout(false);
    }
    const res = renderFrame(c, R, glCv, t);
    if (res === "gbuffer-incomplete") {
      goOff("gbuffer-incomplete");
      return;
    }
    if (import.meta.env.DEV && dbgCv && overlay) drawDebug(c, dbgCv);
  };

  // The host's rect, measured at most once a frame: pointer input between
  // frames reuses the one the frame took (each frame, scroll and resize drops it).
  let hostRect: DOMRect | null = null;
  const hostBox = (): DOMRect => (hostRect ??= host.getBoundingClientRect());

  const boxOnScreen = () => {
    if (!win) return true;
    const r = hostBox();
    if (c.built && laidW >= 0 && (Math.abs(r.width - laidW) > 0.5 || Math.abs(r.height - laidH) > 0.5)) c.relayoutSoon = true;
    c.viewY1 = win.innerHeight - r.top;
    // A size the next frame lays out first: never judged by the old perch.
    if (c.relayoutSoon) return true;
    return cubOnScreen(c, r.left, r.top, win.innerWidth, win.innerHeight);
  };
  const playing = () => !c.destroyed && motionOK(c) && c.visible && !doc.hidden && c.built && boxOnScreen();
  c.playing = playing;

  const active = (t: number): boolean => {
    const { CWV, FL, BOOP, SHY, SHIFT, EYE, TAP, CUR, PT, LOOK, ink } = c;
    for (let i = 0; i < 8; i++) if (Math.abs(CWV[i]) > 0.02) return true;
    if (
      t - FL.t0 < 1.6 ||
      t - BOOP.t0 < 1.8 ||
      t - SHY.t0 < 1.4 ||
      Math.abs(SHIFT.v) > 0.3 ||
      Math.abs(SHIFT.x - SHIFT.target) > 0.5 ||
      ink.sets.length ||
      ink.pend ||
      ink.queue.length
    )
      return true;
    if (t - EYE.sacT < 0.1 || c.LIDNOW < 0.3) return true;
    if (t - TAP.t0 > -0.2 && t - TAP.t0 < 1.55) return true;
    {
      const e = attNow(c, t).e;
      if (e > 0.01 && e < 0.99 && attNow(c, t + 0.05).e > e + 1e-3) return true;
    }
    if (CUR.engaged && t - PT.moveT < 1.2) return true;
    if ((LOOK.on || LOOK.e > 0.05) && Math.abs(CUR.psiV) > 0.04) return true;
    const d = demoAt(c);
    return d.live && turnActive(o.timeline, d.td);
  };

  let turnReadySent = false;
  const loop = (ts: number) => {
    c.raf = 0;
    hostRect = null;
    if (!playing()) {
      setPress(false);
      return;
    }
    if (c.lastRender && ts - c.lastRender < 14) {
      c.raf = view.requestAnimationFrame(loop);
      return;
    }
    const dt = c.lastRender ? Math.min(0.05, (ts - c.lastRender) / 1000) : 0;
    c.lastRender = ts;
    c.simClock += dt;
    if (!c.helloPinned) {
      const d = demoAt(c);
      if (d.live) c.helloShift = helloShiftFor(o.timeline, c.simClock, d.td, c.helloShift);
    }
    c.inLoop = true;
    try {
      stepInteract(c, dt, c.simClock);
      render(c.simClock);
      inkDraw(c, c.simClock);
    } finally {
      c.inLoop = false;
    }
    if (c.destroyed || !glReady()) return;
    // The turn's own clock runs in real time, the hello in sim time, which
    // lags on a slow frame: 0.3 s of slack keeps the arm off the wave.
    if (!turnReadySent && c.simClock >= o.timeline.hello.out + c.helloShift + HELLO_TAIL - o.timeline.busy[0] + 0.3) {
      turnReadySent = true;
      options.onReadyForTurn?.();
      if (c.destroyed) return;
    }
    {
      const d = demoAt(c);
      setPress(d.live && c.LASTACT.wR > 0 && pressOn(o.timeline, d.td));
    }
    if (active(c.simClock)) c.raf = view.requestAnimationFrame(loop);
    else
      c.idleTO = view.setTimeout(() => {
        c.idleTO = 0;
        if (!c.raf && !c.destroyed) c.raf = view.requestAnimationFrame(loop);
      }, 26);
  };

  const kick = () => {
    if (!playing() || c.inLoop) return;
    if (c.idleTO) {
      view.clearTimeout(c.idleTO);
      c.idleTO = 0;
    }
    if (!c.raf) c.raf = view.requestAnimationFrame(loop);
  };
  c.kick = kick;

  const calmFrame = () => {
    const { CUR, CW, CWV, FL, SHIFT } = c;
    CUR.w = 0;
    CUR.arm = -1;
    CUR.engaged = false;
    CW.fill(0);
    CWV.fill(0);
    FL.t0 = -99;
    SHIFT.x = SHIFT.v = SHIFT.target = 0;
    setPress(false);
    render(STILL_T);
  };

  const rebuild = (force: boolean) => {
    if (c.destroyed) return;
    if (!layout(force) && !c.L) return;
    c.built = true;
    if (!demoMotion(c)) host.dataset.cubCalm = "";
    else delete host.dataset.cubCalm;
    if (!glReady()) {
      fallbackArt();
      return;
    }
    if (o.still) render(o.still.t);
    else if (!motionOK(c)) calmFrame();
    else {
      render(c.simClock);
      kick();
    }
  };

  const initGL = (): boolean => {
    if (!gl) return false;
    const r = new CubGl(gl);
    let ok = false;
    try {
      ok = r.init();
    } catch {
      ok = false;
    }
    if (!ok) {
      r.dispose();
      R = null;
      c.glOK = false;
      return false;
    }
    R = r;
    c.glOK = true;
    return true;
  };

  const start = () => {
    if (c.started || c.destroyed) return;
    c.started = true;
    rebuild(true);
  };

  // --- input ---
  const heroXY = (e: PointerEvent): [number, number] => {
    const r = hostBox();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const onControl = (e: Event): boolean => {
    const tg = e.target;
    return typeof Element !== "undefined" && tg instanceof Element && !!tg.closest(o.controlSelector);
  };
  const interactive = () => !o.still && !c.destroyed;

  const onMove = (e: PointerEvent) => {
    // Nothing to follow while he is off screen or the tab is hidden.
    if (!interactive() || e.pointerType !== "mouse" || !c.L || !c.visible || doc.hidden) return;
    const { PT, CUR, SHY, EYE, FL, ATT, BODYC } = c;
    const [x, y] = heroXY(e);
    const ts = e.timeStamp / 1000;
    if (PT.in && ts > PT.ts) {
      const dt = Math.max(ts - PT.ts, 0.004);
      const ivx = (x - PT.x) / dt;
      const ivy = (y - PT.y) / dt;
      const k = Math.min(1, dt / 0.05);
      PT.vx = lerp(PT.vx, ivx, k);
      PT.vy = lerp(PT.vy, ivy, k);
    } else {
      PT.vx = PT.vy = 0;
    }
    PT.x = x;
    PT.y = y;
    PT.ts = ts;
    PT.in = true;
    PT.moveT = c.simClock;
    if (Math.hypot(x - PT.ax, y - PT.ay) > 8) {
      PT.ax = x;
      PT.ay = y;
      PT.stillT = c.simClock;
    }
    const ctl = onControl(e);
    PT.ctl = ctl;
    PT.text = textAt(c, x, y);
    const w = c.L.win;
    PT.inWin = x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h;
    if (noticeOK(c) && fine(c)) {
      // The shy flinch: a fast approach makes Cub squeeze his eyes and curl in.
      const dx = BODYC[0] - x;
      const dy = BODYC[1] - y;
      const D = Math.hypot(dx, dy) || 1;
      const toward = (PT.vx * dx + PT.vy * dy) / D;
      if (toward > 1200 && nearDist(c, x, y) < 300 && c.simClock - CUR.shyT > 1.2) {
        CUR.shyT = c.simClock;
        SHY.t0 = c.simClock;
        SHY.arm = CUR.arm;
        CUR.engaged = false;
        EYE.squeezeT = c.simClock;
        EYE.sqHap = 0;
        if (c.simClock - FL.t0 > 0.9) {
          FL.t0 = c.simClock;
          FL.amp = 0.38;
        }
        ATT.nearT = c.simClock;
      }
    }
    setHot(glReady() && hitAt(c, x, y, 2) && !ctl);
    if (!c.raf && !c.idleTO) kick();
  };
  const onLeave = () => {
    c.PT.in = false;
    c.CUR.engaged = false;
    setHot(false);
    kick();
  };
  const onBlur = () => {
    c.PT.in = false;
    c.CUR.engaged = false;
    setHot(false);
  };
  const onDown = (e: PointerEvent) => {
    if (!interactive() || !glReady() || !c.L || onControl(e)) return;
    if (e.pointerType === "mouse") {
      if (e.button === 0) {
        const [x, y] = heroXY(e);
        if (hitAt(c, x, y, 2)) {
          e.preventDefault();
          poke(c);
        }
      }
      return;
    }
    c.taps.set(e.pointerId, { x: e.clientX, y: e.clientY, t: view.performance.now(), sy: win ? win.scrollY : 0, sx: win ? win.scrollX : 0 });
  };
  const onUp = (e: PointerEvent) => {
    const s = c.taps.get(e.pointerId);
    c.taps.delete(e.pointerId);
    if (!s || e.pointerType === "mouse" || !interactive() || !glReady()) return;
    const sy = win ? win.scrollY : 0;
    const sx = win ? win.scrollX : 0;
    if (
      Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10 ||
      view.performance.now() - s.t > 350 ||
      Math.abs(sy - s.sy) > 2 ||
      Math.abs(sx - s.sx) > 2 ||
      onControl(e)
    )
      return;
    const [x, y] = heroXY(e);
    if (y < 0 || y > c.cam.H) return;
    if (hitAt(c, x, y, 12)) poke(c);
    else if (noticeOK(c)) {
      c.TOUCHG.t0 = c.simClock;
      c.TOUCHG.x = x;
      c.TOUCHG.y = y;
      kick();
    }
  };
  const onCancel = (e: PointerEvent) => {
    c.taps.delete(e.pointerId);
  };
  const wake = () => {
    hostRect = null;
    if (!c.raf && !c.idleTO) kick();
    const I = c.ink;
    if (I.sets.length || I.pend || I.queue.length || I.pauseTO) inkPause(c);
  };
  // Resizes settle for 60 ms before Cub lays out again.
  let resizeT = 0;
  const scheduleRebuild = () => {
    hostRect = null;
    if (!c.started || c.destroyed) return;
    view.clearTimeout(resizeT);
    resizeT = view.setTimeout(() => {
      resizeT = 0;
      rebuild(false);
    }, 60);
  };
  const onResize = () => {
    wake();
    scheduleRebuild();
  };
  const onVisibility = () => {
    kick();
    inkPause(c);
  };

  if (win) {
    win.addEventListener("pointermove", onMove, { passive: true, signal: sig });
    win.addEventListener("blur", onBlur, { signal: sig });
    win.addEventListener("pointerdown", onDown, { passive: false, signal: sig });
    win.addEventListener("pointerup", onUp, { passive: true, signal: sig });
    win.addEventListener("pointercancel", onCancel, { signal: sig });
    win.addEventListener("scroll", wake, { passive: true, signal: sig });
    win.addEventListener("resize", onResize, { signal: sig });
  }
  doc.addEventListener("pointerleave", onLeave, { signal: sig });
  doc.addEventListener("visibilitychange", onVisibility, { signal: sig });

  // --- observers ---
  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver((es) => {
      c.visible = es[es.length - 1].isIntersecting;
      kick();
      inkPause(c);
    });
    io.observe(glCv);
  }
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(scheduleRebuild);
    ro.observe(host);
  }
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts && fonts.ready)
    void fonts.ready.then(() => {
      if (c.started && !c.destroyed) rebuild(false);
    });

  // --- context loss ---
  if (gl) {
    glCv.addEventListener(
      "webglcontextlost",
      (e) => {
        e.preventDefault();
        if (c.destroyed) return;
        c.glLost = true;
        goOff("context-lost");
      },
      { signal: sig },
    );
    glCv.addEventListener(
      "webglcontextrestored",
      () => {
        if (c.destroyed) return;
        c.glLost = false;
        if (initGL()) {
          setStatus("on");
          if (fbLayer) fbLayer.hide();
          rebuild(true);
        } else goOff("init-failed");
      },
      { signal: sig },
    );
  }

  // --- boot ---
  let bootRaf = 0;
  let bootTO = 0;
  const go = () => {
    bootRaf = 0;
    bootTO = 0;
    if (c.destroyed) return;
    if (initGL()) setStatus("on");
    else {
      setStatus("off", "init-failed");
    }
    start();
  };
  if (gl) {
    // Shader compilation waits for first paint (the fallback stays hidden meanwhile).
    if (o.still) go();
    else
      bootRaf = view.requestAnimationFrame(() => {
        bootRaf = 0;
        bootTO = view.setTimeout(go, 0);
      });
  } else {
    setStatus("off", "no-webgl2");
    start();
  }

  const handle: CubHandle = {
    destroy() {
      if (c.destroyed) return;
      c.destroyed = true;
      ac.abort();
      io?.disconnect();
      ro?.disconnect();
      view.clearTimeout(resizeT);
      if (bootRaf) view.cancelAnimationFrame(bootRaf);
      view.clearTimeout(bootTO);
      if (c.raf) view.cancelAnimationFrame(c.raf);
      view.clearTimeout(c.idleTO);
      c.raf = c.idleTO = 0;
      inkDispose(c);
      setPress(false);
      setHot(false);
      c.kick = () => undefined;
      c.playing = () => false;
      if (R) R.dispose();
      R = null;
      if (gl) {
        const ext = gl.getExtension("WEBGL_lose_context");
        ext?.loseContext();
      }
      gl = null;
      glCv.width = glCv.height = 0;
      inkCv.width = inkCv.height = 0;
      glCv.remove();
      inkCv.remove();
      dbgCv?.remove();
      fbLayer?.destroy();
      delete host.dataset.cubGl;
      delete host.dataset.cubCalm;
      delete host.dataset.cubMode;
    },
    setTheme(t) {
      if (c.destroyed) return;
      themeIn = t;
      applyTheme(c, t);
      if (!glReady()) {
        fallbackArt();
        return;
      }
      if (o.still) render(o.still.t);
      else if (!motionOK(c)) calmFrame();
      else render(c.simClock);
      inkDraw(c, c.simClock);
    },
    setReducedMotion(on) {
      if (c.destroyed || c.rmOn === on) return;
      c.rmOn = on;
      // No ink survives a motion change, not even a frozen frame of it.
      inkReset(c);
      rebuild(true);
    },
    setMotion(on) {
      if (c.destroyed || c.motionOn === on) return;
      c.motionOn = on;
      inkReset(c);
      rebuild(true);
    },
    setNoticeEnabled(on) {
      if (c.destroyed || c.noticeOn === on) return;
      c.noticeOn = on;
      if (!on) c.PT.in = false;
      rebuild(true);
    },
    setAnchors(a) {
      anchorsSrc = a;
      handle.relayout();
    },
    relayout() {
      if (c.destroyed || !c.started) return;
      if (playing()) {
        c.relayoutSoon = true;
        kick();
      } else rebuild(false);
    },
    setTurn(t: CubTurn) {
      c.turn = t;
      kick();
    },
    notice(kind) {
      if (c.destroyed || !c.L) return;
      if (kind === "cta") {
        ctaGlance(c);
        return;
      }
      if (!glReady()) return;
      if (!motionOK(c)) {
        calmFrame();
        return;
      }
      const L = c.L;
      if (noticeOK(c)) pulse(c, "fixed", L.kim.x + L.kim.w * 0.3, L.kim.y + L.kim.h * 0.5, 0.55);
      render(c.simClock);
      kick();
    },
    boop() {
      if (c.destroyed || !glReady() || !c.L || isStill(c)) return;
      poke(c);
    },
    getState(): CubPublicState {
      return {
        status,
        mode: c.OC.mode,
        u: c.OC.u,
        bx: c.OC.bx,
        dpr: c.cam.DPR,
        canvas: [glCv.width, glCv.height],
        playing: playing(),
        simClock: c.simClock,
        turn: demoAt(c),
        reach: c.LASTACT.wR,
        ink: c.ink.sets.length,
      };
    },
  };

  if (import.meta.env.DEV && debugOn)
    handle.dev = createDevHooks(c, {
      host,
      glCanvas: glCv,
      gl: () => (glReady() ? gl : null),
      render,
      setTheme: (t) => {
        themeIn = t;
        applyTheme(c, t);
      },
      getTheme: () => themeIn,
      overlay: (on) => {
        overlay = on;
        if (dbgCv) dbgCv.style.display = on ? "block" : "none";
        if (on && dbgCv && c.L) drawDebug(c, dbgCv);
      },
    });

  return handle;
}
