import { useEffect, useRef } from "react";
import type { KnoshFaceMood } from "../knoshRuntimeState";

// Knosh face — locked design v1 (knosh repo docs/design/robot-face.md).
// Two huge luminous amber eyes with deep-amber pupils and catchlights carry
// every expression; no mouth. Fault ("error" mood) = X-eyes gone cold.
// All motion runs on under-damped springs; the reference implementation is
// the prototype linked from the design doc — keep the two in sync.

const GROUND = "#0A0908";
const EYE = "#FFE3B3";
const GLOW = "#FFB259";
const PUPIL = "#8F5314";
const GLINT = "#FFFBF0";
const COLD = "#7A6A50";

type FaceStateSpec = {
  aperture: number;
  width: number;
  height: number;
  gazeY: number;
  lift: number;
  glow: number;
  happy: number;
  pupil: number;
  lidAngle: number;
  blink: boolean;
};

// `acting` (robot performing a motion command) is an Instafy-side addition to
// the six spec states: alert idle with a focus lid — engaged, not "thinking".
const FACE_STATES: Record<KnoshFaceMood, FaceStateSpec> = {
  sleeping: {
    aperture: 0.06, width: 1.0, height: 0.9, gazeY: 0.35, lift: 0.06,
    glow: 0.25, happy: 0.15, pupil: 1.0, lidAngle: 0, blink: false,
  },
  idle: {
    aperture: 1.0, width: 1.0, height: 1.0, gazeY: 0, lift: 0,
    glow: 0.8, happy: 0.22, pupil: 1.0, lidAngle: 0, blink: true,
  },
  listening: {
    aperture: 1.0, width: 1.06, height: 1.14, gazeY: -0.12, lift: -0.03,
    glow: 1.0, happy: 0.45, pupil: 1.3, lidAngle: 0, blink: true,
  },
  thinking: {
    aperture: 0.62, width: 0.96, height: 0.94, gazeY: -0.3, lift: -0.02,
    glow: 0.7, happy: 0.05, pupil: 0.78, lidAngle: 0.12, blink: true,
  },
  speaking: {
    aperture: 0.94, width: 1.0, height: 1.04, gazeY: 0.02, lift: 0,
    glow: 0.95, happy: 0.5, pupil: 1.05, lidAngle: 0, blink: true,
  },
  acting: {
    aperture: 0.96, width: 1.02, height: 1.04, gazeY: -0.05, lift: -0.01,
    glow: 0.9, happy: 0.3, pupil: 1.1, lidAngle: 0.06, blink: true,
  },
  error: {
    aperture: 0.82, width: 1.0, height: 0.88, gazeY: 0.02, lift: 0.01,
    glow: 0.35, happy: 0, pupil: 0.7, lidAngle: 0, blink: false,
  },
};

type Spring = { x: number; v: number };

function makeSpring(value: number): Spring {
  return { x: value, v: 0 };
}

function springTo(spring: Spring, target: number, dt: number, reduced: boolean) {
  const k = 90;
  const d = reduced ? 19 : 12;
  spring.v += (k * (target - spring.x) - d * spring.v) * dt;
  spring.x += spring.v * dt;
}

function easeTo(current: number, target: number, rate: number, dt: number) {
  return current + (target - current) * Math.min(1, rate * dt);
}

function mixHex(a: string, b: string, t: number) {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const pa = parse(a);
  const pb = parse(b);
  const out = pa.map((value, i) => Math.round(value + (pb[i] - value) * t));
  return `rgb(${out[0]}, ${out[1]}, ${out[2]})`;
}

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

type FaceRuntime = {
  springs: {
    aperture: Spring;
    width: Spring;
    height: Spring;
    lift: Spring;
    happy: Spring;
    pupil: Spring;
    lidAngle: Spring;
  };
  gazeX: number;
  gazeY: number;
  glow: number;
  cold: number;
  blink: number;
  tilt: number;
  tiltTarget: number;
  now: number;
  nextBlinkAt: number;
  blinkPhase: number;
  nextSaccadeAt: number;
  saccade: { x: number; y: number };
  nextTiltAt: number;
  tiltUntil: number;
  winkPhase: number;
  speech: { level: number; nextEventAt: number; talking: boolean };
};

function createRuntime(): FaceRuntime {
  return {
    springs: {
      aperture: makeSpring(1),
      width: makeSpring(1),
      height: makeSpring(1),
      lift: makeSpring(0),
      happy: makeSpring(0.22),
      pupil: makeSpring(1),
      lidAngle: makeSpring(0),
    },
    gazeX: 0,
    gazeY: 0,
    glow: 0.8,
    cold: 0,
    blink: 0,
    tilt: 0,
    tiltTarget: 0,
    now: 0,
    nextBlinkAt: 2.5,
    blinkPhase: -1,
    nextSaccadeAt: 1.5,
    saccade: { x: 0, y: 0 },
    nextTiltAt: 4,
    tiltUntil: 0,
    winkPhase: -1,
    speech: { level: 0, nextEventAt: 0, talking: true },
  };
}

function updateFace(
  runtime: FaceRuntime,
  mood: KnoshFaceMood,
  previousMood: KnoshFaceMood,
  dt: number,
  reduced: boolean,
) {
  runtime.now += dt;
  const spec = FACE_STATES[mood];

  if (previousMood !== mood) {
    if (mood === "listening" && !reduced) {
      runtime.winkPhase = 0;
    }
    if (previousMood === "sleeping" && mood !== "sleeping" && !reduced) {
      // Wake-up stretch: the eyes pop open with overshoot.
      runtime.springs.aperture.v += 6;
      runtime.springs.height.v += 2.5;
    }
    if (mood === "speaking") {
      runtime.speech = { level: 0, nextEventAt: runtime.now, talking: true };
    }
  }

  springTo(runtime.springs.aperture, spec.aperture, dt, reduced);
  springTo(runtime.springs.width, spec.width, dt, reduced);
  springTo(runtime.springs.height, spec.height, dt, reduced);
  springTo(runtime.springs.lift, spec.lift, dt, reduced);
  springTo(runtime.springs.happy, spec.happy, dt, reduced);
  springTo(runtime.springs.pupil, spec.pupil, dt, reduced);
  springTo(runtime.springs.lidAngle, spec.lidAngle, dt, reduced);
  runtime.glow = easeTo(runtime.glow, spec.glow, 3, dt);
  runtime.cold = easeTo(runtime.cold, mood === "error" ? 1 : 0, 3, dt);

  // Blinks: quick close, softer open, occasional double.
  if (spec.blink && !reduced) {
    if (runtime.blinkPhase < 0 && runtime.now >= runtime.nextBlinkAt) {
      runtime.blinkPhase = 0;
    }
    if (runtime.blinkPhase >= 0) {
      runtime.blinkPhase += dt;
      const closeT = 0.09;
      const openT = 0.15;
      if (runtime.blinkPhase < closeT) {
        runtime.blink = runtime.blinkPhase / closeT;
      } else if (runtime.blinkPhase < closeT + openT) {
        runtime.blink = 1 - (runtime.blinkPhase - closeT) / openT;
      } else {
        runtime.blink = 0;
        runtime.blinkPhase = -1;
        runtime.nextBlinkAt =
          runtime.now + (Math.random() < 0.14 ? rand(0.25, 0.4) : rand(2.8, 6.5));
      }
    }
  } else {
    runtime.blink = easeTo(runtime.blink, 0, 6, dt);
  }

  if (runtime.winkPhase >= 0) {
    runtime.winkPhase += dt;
    if (runtime.winkPhase > 0.42) {
      runtime.winkPhase = -1;
    }
  }

  // Gaze: micro-saccades in idle/acting, scanning in listening (on the robot
  // this follows the mic array's source_angle_deg), up-and-aside in thinking.
  let gx = 0;
  let gy = spec.gazeY;
  if (!reduced) {
    if (mood === "idle" || mood === "acting") {
      if (runtime.now >= runtime.nextSaccadeAt) {
        runtime.saccade.x = rand(-0.5, 0.5) * (Math.random() < 0.25 ? 1.6 : 0.5);
        runtime.saccade.y = rand(-0.15, 0.2);
        runtime.nextSaccadeAt = runtime.now + rand(0.9, 3.4);
      }
      gx = runtime.saccade.x;
      gy += runtime.saccade.y;
    } else if (mood === "listening") {
      gx = Math.sin(runtime.now * 0.7) * 0.55;
      if (Math.random() < dt * 1.2) {
        // Hearing something = perk up: a small spring kick to the eyes.
        runtime.springs.height.v += 0.55;
        runtime.springs.width.v += 0.18;
      }
    } else if (mood === "thinking") {
      gx = (Math.floor(runtime.now / 1.6) % 2 === 0 ? 1 : -1) * 0.42;
      gy += Math.sin(runtime.now * 0.8) * 0.04;
    } else if (mood === "sleeping") {
      gy += Math.sin(runtime.now * 0.5) * 0.02;
    }
  }
  runtime.gazeX = easeTo(runtime.gazeX, gx, 4, dt);
  runtime.gazeY = easeTo(runtime.gazeY, gy, 4, dt);

  // Head tilt: puppy curiosity in idle, a lean while listening, a shiver in
  // fault. (The servo neck performs the physical version on the robot.)
  if (!reduced && mood === "idle") {
    if (runtime.now >= runtime.nextTiltAt) {
      runtime.tiltTarget = rand(0.05, 0.09) * (Math.random() < 0.5 ? -1 : 1);
      runtime.tiltUntil = runtime.now + rand(1.2, 2.2);
      runtime.nextTiltAt = runtime.now + rand(5, 11);
    }
    if (runtime.now >= runtime.tiltUntil) {
      runtime.tiltTarget = 0;
    }
  } else if (!reduced && mood === "listening") {
    runtime.tiltTarget = runtime.gazeX * 0.07;
  } else {
    runtime.tiltTarget = 0;
  }
  let tilt = easeTo(runtime.tilt, runtime.tiltTarget, 3.2, dt);
  if (mood === "error" && !reduced) {
    tilt += Math.sin(runtime.now * 40) * Math.max(0, 0.5 - (runtime.now % 2.4)) * 0.03;
  }
  runtime.tilt = tilt;

  // Speech envelope: synthesized phrase bursts. When live TTS amplitude
  // becomes available, feed it here instead.
  if (mood === "speaking") {
    if (runtime.now >= runtime.speech.nextEventAt) {
      runtime.speech.talking = !runtime.speech.talking || Math.random() < 0.75;
      runtime.speech.nextEventAt =
        runtime.now + (runtime.speech.talking ? rand(0.5, 1.6) : rand(0.2, 0.55));
    }
    const target = runtime.speech.talking ? rand(0.35, 1) : 0.05;
    runtime.speech.level = easeTo(runtime.speech.level, target, 12, dt);
  } else {
    runtime.speech.level = easeTo(runtime.speech.level, 0, 6, dt);
  }
}

function drawFace(
  ctx: CanvasRenderingContext2D,
  eyeCtx: CanvasRenderingContext2D,
  eyeLayer: HTMLCanvasElement,
  canvas: HTMLCanvasElement,
  runtime: FaceRuntime,
  mood: KnoshFaceMood,
  reduced: boolean,
) {
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (W <= 0 || H <= 0) {
    return;
  }
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, W, H);

  const unit = Math.min(W, H);

  // Slow whole-face orbit — OLED burn-in mitigation that reads as breathing.
  const orbitA = reduced ? 0 : 1;
  const ox = Math.sin((runtime.now * 2 * Math.PI) / 90) * 4 * orbitA;
  const oy = Math.cos((runtime.now * 2 * Math.PI) / 117) * 3 * orbitA;

  const cx = W / 2 + ox;
  const cy = H * 0.5 + oy + runtime.springs.lift.x * unit;

  // Warm hearth vignette behind the face, breathing with the glow.
  const halo = ctx.createRadialGradient(cx, cy, unit * 0.1, cx, cy, unit * 0.75);
  halo.addColorStop(0, `rgba(255, 178, 89, ${0.05 * runtime.glow})`);
  halo.addColorStop(1, "rgba(255, 178, 89, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, H);

  // Layout: the eyes devour the stage — together they span ~70% of the width
  // so every expression reads from across a room.
  const baseW = Math.min(W * 0.24, H * 0.52);
  const baseH = Math.min(H * 0.6, baseW * 1.3);
  const eyeW = baseW * runtime.springs.width.x;
  const eyeH = baseH * runtime.springs.height.x;
  const gap = W * 0.46;
  const speechSquash = 1 + runtime.speech.level * 0.11;
  const open = Math.max(0.03, runtime.springs.aperture.x * (1 - runtime.blink));
  const gazeRangeX = unit * 0.03;
  const gazeRangeY = unit * 0.025;
  const happy = Math.max(0, Math.min(1, runtime.springs.happy.x)) * open;

  if (eyeLayer.width !== canvas.width || eyeLayer.height !== canvas.height) {
    eyeLayer.width = canvas.width;
    eyeLayer.height = canvas.height;
  }
  eyeCtx.setTransform(1, 0, 0, 1, 0, 0);
  eyeCtx.clearRect(0, 0, eyeLayer.width, eyeLayer.height);
  eyeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  eyeCtx.translate(cx, cy);
  eyeCtx.rotate(runtime.tilt);
  eyeCtx.translate(runtime.gazeX * gazeRangeX, runtime.gazeY * gazeRangeY);

  for (const side of [-1, 1]) {
    // Wink: the right eye dips closed once when listening starts.
    let sideOpen = open;
    if (runtime.winkPhase >= 0 && side === 1) {
      const closeT = 0.1;
      const holdT = 0.12;
      const openT = 0.2;
      let winkAmount = 0;
      if (runtime.winkPhase < closeT) {
        winkAmount = runtime.winkPhase / closeT;
      } else if (runtime.winkPhase < closeT + holdT) {
        winkAmount = 1;
      } else {
        winkAmount = Math.max(0, 1 - (runtime.winkPhase - closeT - holdT) / openT);
      }
      sideOpen = Math.max(0.05, open * (1 - winkAmount));
    }

    const h = eyeH * sideOpen * speechSquash;
    const w = eyeW * (1 + (1 - sideOpen) * 0.12) * (1 - runtime.speech.level * 0.015);
    const x = (side * gap) / 2 - w / 2;
    const cold = Math.min(1, runtime.cold);
    const fill = cold > 0.01 ? mixHex(EYE, COLD, cold * 0.85) : EYE;

    eyeCtx.globalCompositeOperation = "source-over";
    if (cold < 0.995) {
      eyeCtx.globalAlpha = 1 - cold;
      eyeCtx.fillStyle = fill;
      roundedRectPath(eyeCtx, x, -h / 2, w, h, w * 0.48);
      eyeCtx.fill();
      eyeCtx.globalAlpha = 1;
    }

    // Fault: the eye becomes a thick X — the universal "knocked out" mark,
    // readable across a room. Crossfades in as the light goes cold.
    if (cold > 0.005) {
      eyeCtx.globalAlpha = cold;
      eyeCtx.strokeStyle = fill;
      eyeCtx.lineCap = "round";
      eyeCtx.lineWidth = w * 0.17;
      const insetX = w * 0.16;
      const insetY = h * 0.14;
      eyeCtx.beginPath();
      eyeCtx.moveTo(x + insetX, -h / 2 + insetY);
      eyeCtx.lineTo(x + w - insetX, h / 2 - insetY);
      eyeCtx.moveTo(x + w - insetX, -h / 2 + insetY);
      eyeCtx.lineTo(x + insetX, h / 2 - insetY);
      eyeCtx.stroke();
      eyeCtx.globalAlpha = 1;
    }

    // Pupil + catchlight, clipped to the eye. Gaze lives here; the eyelid
    // genuinely covers it as the eye closes.
    const lidCover = Math.min(1, Math.max(0, (sideOpen - 0.18) / 0.3)) * (1 - cold);
    if (lidCover > 0.01) {
      eyeCtx.save();
      roundedRectPath(eyeCtx, x, -h / 2, w, h, w * 0.48);
      eyeCtx.clip();
      const pupilR = 0.3 * w * Math.max(0.3, runtime.springs.pupil.x);
      const px = (side * gap) / 2 + runtime.gazeX * w * 0.22;
      const py = runtime.gazeY * h * 0.16;
      eyeCtx.globalAlpha = lidCover;
      eyeCtx.fillStyle = PUPIL;
      eyeCtx.beginPath();
      eyeCtx.ellipse(px, py, pupilR, pupilR * 1.12, 0, 0, Math.PI * 2);
      eyeCtx.fill();
      eyeCtx.fillStyle = GLINT;
      eyeCtx.beginPath();
      eyeCtx.arc(px - pupilR * 0.34, py - pupilR * 0.38, pupilR * 0.22, 0, Math.PI * 2);
      eyeCtx.fill();
      eyeCtx.globalAlpha = 1;
      eyeCtx.restore();
    }

    // Smile-eyes: the lower lid arcs up into the eye — cut with real
    // transparency (never background paint).
    const lidRise =
      happy * (side === 1 && runtime.winkPhase >= 0 ? sideOpen / open : 1) * (1 - cold);
    if (lidRise > 0.02) {
      const r = w * 1.05;
      eyeCtx.globalCompositeOperation = "destination-out";
      eyeCtx.beginPath();
      eyeCtx.ellipse((side * gap) / 2, h / 2 + r - lidRise * h * 0.5, r, r, 0, 0, Math.PI * 2);
      eyeCtx.fill();
      eyeCtx.globalCompositeOperation = "source-over";
    }

    // Lid angle — the "eyebrow" channel without an eyebrow element: a tilted
    // cut across the top of the eye (inner-corner-down = focus).
    const lidAngle = runtime.springs.lidAngle.x * (1 - cold);
    if (Math.abs(lidAngle) > 0.005) {
      eyeCtx.save();
      eyeCtx.globalCompositeOperation = "destination-out";
      eyeCtx.translate((side * gap) / 2, -h / 2 + h * 0.05);
      eyeCtx.rotate(side * lidAngle);
      eyeCtx.fillRect(-w, -h, w * 2, h);
      eyeCtx.restore();
      eyeCtx.globalCompositeOperation = "source-over";
    }
  }

  // Composite the eyes over the scene; sleep breathes in brightness so the
  // face reads alive-asleep even across a room.
  const savedTransform = ctx.getTransform();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const sleepBreath =
    mood === "sleeping" && !reduced
      ? 0.72 + (0.28 * (Math.sin((runtime.now * 2 * Math.PI) / 5) + 1)) / 2
      : 1;
  ctx.globalAlpha = sleepBreath;
  ctx.shadowColor = GLOW;
  ctx.shadowBlur = unit * 0.05 * runtime.glow * sleepBreath * dpr;
  ctx.drawImage(eyeLayer, 0, 0);
  ctx.globalAlpha = 1;
  ctx.setTransform(savedTransform);
  ctx.shadowBlur = 0;
}

export type KnoshFaceCanvasProps = {
  mood: KnoshFaceMood;
  className?: string;
  "data-testid"?: string;
};

export function KnoshFaceCanvas({
  mood,
  className,
  "data-testid": dataTestId,
}: KnoshFaceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const moodRef = useRef<KnoshFaceMood>(mood);
  moodRef.current = mood;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const eyeLayer = document.createElement("canvas");
    const eyeCtx = eyeLayer.getContext("2d");
    if (!eyeCtx) {
      return;
    }

    const reduced =
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const runtime = createRuntime();
    let previousMood = moodRef.current;
    let frameId: number | null = null;
    let last = performance.now();

    const frame = (time: number) => {
      frameId = null;
      const dt = Math.min(0.05, (time - last) / 1000);
      last = time;
      const currentMood = moodRef.current;
      updateFace(runtime, currentMood, previousMood, dt, reduced);
      previousMood = currentMood;
      drawFace(ctx, eyeCtx, eyeLayer, canvas, runtime, currentMood, reduced);
      schedule();
    };

    const schedule = () => {
      if (frameId === null && !document.hidden) {
        frameId = globalThis.requestAnimationFrame(frame);
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        if (frameId !== null) {
          globalThis.cancelAnimationFrame(frameId);
          frameId = null;
        }
      } else {
        last = performance.now();
        schedule();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    schedule();

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      if (frameId !== null) {
        globalThis.cancelAnimationFrame(frameId);
        frameId = null;
      }
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      data-testid={dataTestId}
      data-mood={mood}
      aria-label="Knosh face"
      role="img"
    />
  );
}
