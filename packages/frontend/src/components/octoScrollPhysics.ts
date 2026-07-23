/**
 * A DOM-free spring model for making Octo's tentacles trail behind page motion.
 *
 * Coordinate conventions:
 * - SVG +y points down.
 * - Browser scroll position increases while scrolling down.
 * - A sticky Octo treats the scroll gesture as the body's movement through water.
 * - Its free tentacle ends lag opposite that gesture: scrolling down lifts them up.
 *
 * Callers should sample this on every animation frame, including while the scroll
 * position is stationary, so the springs can settle. Reduced-motion policy stays
 * with the caller because this module deliberately has no browser dependencies.
 */

export const OCTO_SCROLL_ARM_COUNT = 4;

export type OctoScrollPoint = Readonly<{
  x: number;
  y: number;
}>;

export type OctoScrollArmDeformation = Readonly<{
  /** Zero by design so the tentacle remains attached to the body. */
  root: OctoScrollPoint;
  /** Offset suitable for geometry around the first quarter of an arm. */
  proximal: OctoScrollPoint;
  /** Offset suitable for geometry around the middle of an arm. */
  middle: OctoScrollPoint;
  /** The full distal offset, in units of Octo's 64x64 SVG viewBox. */
  tip: OctoScrollPoint;
}>;

export type OctoScrollMantleDeformation = Readonly<{
  /** Normalized directional compression, from neutral (0) to the clamped maximum (1). */
  squash: number;
  /** Normalized directional elongation, from neutral (0) to the clamped maximum (1). */
  stretch: number;
  scaleX: number;
  scaleY: number;
  /** Vertical bias in 64x64 SVG units; positive values move down. */
  translateY: number;
}>;

export type OctoScrollDeformation = Readonly<{
  arms: readonly OctoScrollArmDeformation[];
  mantle: OctoScrollMantleDeformation;
  active: boolean;
}>;

export type OctoScrollPhysicsInput =
  | Readonly<{
      kind: "position";
      timeMs: number;
      scrollPositionPx: number;
    }>
  | Readonly<{
      kind: "kinematics";
      timeMs: number;
      scrollVelocityPxPerSecond: number;
      /** When omitted, acceleration is derived from the previous velocity sample. */
      scrollAccelerationPxPerSecondSquared?: number;
    }>;

export type OctoScrollPhysicsResetReason =
  | "input-mode-change"
  | "invalid-input"
  | "position-jump"
  | "sample-gap"
  | "time-reversal";

export type OctoScrollPhysicsConfig = Readonly<{
  /** Maximum length of a distal deformation vector in 64x64 SVG units. */
  maxTipOffsetSvg: number;
  /** Ignore stale animation frames after this gap, such as after tab suspension. */
  discontinuityGapMs: number;
  /** Treat anchor jumps and restored scroll positions as resets rather than flings. */
  maxPositionJumpPx: number;
  /** Caps the amount of simulation time consumed by one delayed frame. */
  maxFrameDeltaSeconds: number;
  /** Semi-implicit Euler substeps keep the spring stable and frame-rate tolerant. */
  maxSubstepSeconds: number;
  maxScrollVelocityPxPerSecond: number;
  maxScrollAccelerationPxPerSecondSquared: number;
  positionVelocitySmoothingSeconds: number;
  springStiffnessPerSecondSquared: number;
  springDampingPerSecond: number;
  velocityDrag: number;
  accelerationKick: number;
  activeOffsetThresholdSvg: number;
  activeVelocityThresholdSvgPerSecond: number;
}>;

export const DEFAULT_OCTO_SCROLL_PHYSICS_CONFIG: OctoScrollPhysicsConfig = Object.freeze({
  // Fits the scroll-driven canonical limbs inside Octo's fixed 64x64 viewBox.
  maxTipOffsetSvg: 5.25,
  discontinuityGapMs: 180,
  maxPositionJumpPx: 720,
  maxFrameDeltaSeconds: 1 / 20,
  maxSubstepSeconds: 1 / 120,
  maxScrollVelocityPxPerSecond: 3_600,
  maxScrollAccelerationPxPerSecondSquared: 26_000,
  positionVelocitySmoothingSeconds: 0.05,
  springStiffnessPerSecondSquared: 46,
  springDampingPerSecond: 13.5,
  velocityDrag: 0.14,
  accelerationKick: 0.018,
  activeOffsetThresholdSvg: 0.01,
  activeVelocityThresholdSvgPerSecond: 0.025,
});

type OctoScrollArmState = Readonly<{
  offsetSvg: number;
  velocitySvgPerSecond: number;
}>;

type OctoScrollInputMode = OctoScrollPhysicsInput["kind"];

export type OctoScrollPhysicsState = Readonly<{
  initialized: boolean;
  inputMode: OctoScrollInputMode | null;
  lastTimeMs: number | null;
  lastScrollPositionPx: number | null;
  scrollVelocityPxPerSecond: number;
  scrollAccelerationPxPerSecondSquared: number;
  arms: readonly OctoScrollArmState[];
}>;

export type OctoScrollPhysicsFrame = Readonly<{
  state: OctoScrollPhysicsState;
  deformation: OctoScrollDeformation;
  sampleDeltaSeconds: number;
  integratedDeltaSeconds: number;
  scrollVelocityPxPerSecond: number;
  scrollAccelerationPxPerSecondSquared: number;
  /** Page-space motion is the inverse of scroll velocity. */
  bodyScreenVelocityPxPerSecond: number;
  resetReason: OctoScrollPhysicsResetReason | null;
}>;

type ArmDynamics = Readonly<{
  response: number;
  stiffness: number;
  damping: number;
  lateralCoupling: number;
  proximalWeight: number;
  middleWeight: number;
}>;

// Variation is intentionally small: the arms share one coherent gesture but do
// not arrive and settle in mechanical lockstep. Negative lateral coupling bends
// left arms outward while positive coupling mirrors that bend on the right.
const ARM_DYNAMICS: readonly ArmDynamics[] = Object.freeze([
  Object.freeze({
    response: 1.07,
    stiffness: 0.92,
    damping: 0.97,
    lateralCoupling: -0.085,
    proximalWeight: 0.13,
    middleWeight: 0.48,
  }),
  Object.freeze({
    response: 0.96,
    stiffness: 1.05,
    damping: 1.04,
    lateralCoupling: -0.035,
    proximalWeight: 0.15,
    middleWeight: 0.53,
  }),
  Object.freeze({
    response: 1,
    stiffness: 1.01,
    damping: 1.06,
    lateralCoupling: 0.035,
    proximalWeight: 0.14,
    middleWeight: 0.51,
  }),
  Object.freeze({
    response: 1.06,
    stiffness: 0.9,
    damping: 0.95,
    lateralCoupling: 0.085,
    proximalWeight: 0.12,
    middleWeight: 0.46,
  }),
]);

const ZERO_POINT: OctoScrollPoint = Object.freeze({ x: 0, y: 0 });
const NEUTRAL_MANTLE: OctoScrollMantleDeformation = Object.freeze({
  squash: 0,
  stretch: 0,
  scaleX: 1,
  scaleY: 1,
  translateY: 0,
});
const FULL_MANTLE_SQUASH_TIP_Y = 2;
const FULL_MANTLE_STRETCH_TIP_Y = 2.5;
const MAX_MANTLE_HORIZONTAL_EXPANSION = 0.07;
const MAX_MANTLE_VERTICAL_COMPRESSION = 0.1;
const MAX_MANTLE_DOWNWARD_TRANSLATION = 0.65;
const MAX_MANTLE_HORIZONTAL_CONTRACTION = 0.02;
const MAX_MANTLE_VERTICAL_ELONGATION = 0.05;
const MAX_MANTLE_UPWARD_TRANSLATION = 0.12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveConfig(
  overrides: Partial<OctoScrollPhysicsConfig> | undefined,
): OctoScrollPhysicsConfig {
  if (!overrides) {
    return DEFAULT_OCTO_SCROLL_PHYSICS_CONFIG;
  }

  const defaults = DEFAULT_OCTO_SCROLL_PHYSICS_CONFIG;
  return {
    maxTipOffsetSvg: finitePositive(overrides.maxTipOffsetSvg ?? 0, defaults.maxTipOffsetSvg),
    discontinuityGapMs: finitePositive(
      overrides.discontinuityGapMs ?? 0,
      defaults.discontinuityGapMs,
    ),
    maxPositionJumpPx: finitePositive(
      overrides.maxPositionJumpPx ?? 0,
      defaults.maxPositionJumpPx,
    ),
    maxFrameDeltaSeconds: finitePositive(
      overrides.maxFrameDeltaSeconds ?? 0,
      defaults.maxFrameDeltaSeconds,
    ),
    maxSubstepSeconds: finitePositive(
      overrides.maxSubstepSeconds ?? 0,
      defaults.maxSubstepSeconds,
    ),
    maxScrollVelocityPxPerSecond: finitePositive(
      overrides.maxScrollVelocityPxPerSecond ?? 0,
      defaults.maxScrollVelocityPxPerSecond,
    ),
    maxScrollAccelerationPxPerSecondSquared: finitePositive(
      overrides.maxScrollAccelerationPxPerSecondSquared ?? 0,
      defaults.maxScrollAccelerationPxPerSecondSquared,
    ),
    positionVelocitySmoothingSeconds: finitePositive(
      overrides.positionVelocitySmoothingSeconds ?? 0,
      defaults.positionVelocitySmoothingSeconds,
    ),
    springStiffnessPerSecondSquared: finitePositive(
      overrides.springStiffnessPerSecondSquared ?? 0,
      defaults.springStiffnessPerSecondSquared,
    ),
    springDampingPerSecond: finitePositive(
      overrides.springDampingPerSecond ?? 0,
      defaults.springDampingPerSecond,
    ),
    velocityDrag: finitePositive(overrides.velocityDrag ?? 0, defaults.velocityDrag),
    accelerationKick: finitePositive(
      overrides.accelerationKick ?? 0,
      defaults.accelerationKick,
    ),
    activeOffsetThresholdSvg: finitePositive(
      overrides.activeOffsetThresholdSvg ?? 0,
      defaults.activeOffsetThresholdSvg,
    ),
    activeVelocityThresholdSvgPerSecond: finitePositive(
      overrides.activeVelocityThresholdSvgPerSecond ?? 0,
      defaults.activeVelocityThresholdSvgPerSecond,
    ),
  };
}

function createNeutralArms(): readonly OctoScrollArmState[] {
  return ARM_DYNAMICS.map(() => ({ offsetSvg: 0, velocitySvgPerSecond: 0 }));
}

export function createOctoScrollPhysicsState(): OctoScrollPhysicsState {
  return {
    initialized: false,
    inputMode: null,
    lastTimeMs: null,
    lastScrollPositionPx: null,
    scrollVelocityPxPerSecond: 0,
    scrollAccelerationPxPerSecondSquared: 0,
    arms: createNeutralArms(),
  };
}

function isValidInput(input: OctoScrollPhysicsInput): boolean {
  if (!Number.isFinite(input.timeMs)) {
    return false;
  }
  if (input.kind === "position") {
    return Number.isFinite(input.scrollPositionPx);
  }
  return (
    Number.isFinite(input.scrollVelocityPxPerSecond) &&
    (input.scrollAccelerationPxPerSecondSquared === undefined ||
      Number.isFinite(input.scrollAccelerationPxPerSecondSquared))
  );
}

function initializedState(input: OctoScrollPhysicsInput): OctoScrollPhysicsState {
  return {
    initialized: true,
    inputMode: input.kind,
    lastTimeMs: input.timeMs,
    lastScrollPositionPx: input.kind === "position" ? input.scrollPositionPx : null,
    scrollVelocityPxPerSecond: 0,
    scrollAccelerationPxPerSecondSquared: 0,
    arms: createNeutralArms(),
  };
}

/** Clears all stored input and spring momentum. */
export function resetOctoScrollPhysicsState(
  baseline?: OctoScrollPhysicsInput,
): OctoScrollPhysicsState {
  return baseline && isValidInput(baseline)
    ? initializedState(baseline)
    : createOctoScrollPhysicsState();
}

function limitVector(point: OctoScrollPoint, maximumLength: number): OctoScrollPoint {
  const length = Math.hypot(point.x, point.y);
  if (length <= maximumLength || length === 0) {
    return point;
  }
  const scale = maximumLength / length;
  return { x: point.x * scale, y: point.y * scale };
}

function scalePoint(point: OctoScrollPoint, scale: number): OctoScrollPoint {
  const x = point.x * scale;
  const y = point.y * scale;
  return {
    x: Object.is(x, -0) ? 0 : x,
    y: Object.is(y, -0) ? 0 : y,
  };
}

export function getOctoScrollDeformation(
  state: OctoScrollPhysicsState,
  overrides?: Partial<OctoScrollPhysicsConfig>,
): OctoScrollDeformation {
  const config = resolveConfig(overrides);
  let active = false;
  const arms = state.arms.map((arm, index): OctoScrollArmDeformation => {
    const dynamics = ARM_DYNAMICS[index];
    const tip =
      arm.offsetSvg === 0
        ? ZERO_POINT
        : limitVector(
            {
              x: arm.offsetSvg * dynamics.lateralCoupling,
              y: arm.offsetSvg,
            },
            config.maxTipOffsetSvg,
          );
    active ||=
      Math.abs(arm.offsetSvg) > config.activeOffsetThresholdSvg ||
      Math.abs(arm.velocitySvgPerSecond) > config.activeVelocityThresholdSvgPerSecond;

    return {
      root: ZERO_POINT,
      proximal: scalePoint(tip, dynamics.proximalWeight),
      middle: scalePoint(tip, dynamics.middleWeight),
      tip,
    };
  });

  const averageTipY =
    arms.reduce((sum, arm) => sum + arm.tip.y, 0) / Math.max(1, arms.length);
  const linearSquash = clamp(averageTipY / FULL_MANTLE_SQUASH_TIP_Y, 0, 1);
  const linearStretch = clamp(-averageTipY / FULL_MANTLE_STRETCH_TIP_Y, 0, 1);
  // Smoothstep prevents tiny resting oscillations from making the face shimmer,
  // while still making an intentional scroll visibly deform the mantle.
  const squash = linearSquash * linearSquash * (3 - 2 * linearSquash);
  const stretch = linearStretch * linearStretch * (3 - 2 * linearStretch);
  const mantle =
    !active || (squash === 0 && stretch === 0)
      ? NEUTRAL_MANTLE
      : {
          squash,
          stretch,
          scaleX:
            1 +
            MAX_MANTLE_HORIZONTAL_EXPANSION * squash -
            MAX_MANTLE_HORIZONTAL_CONTRACTION * stretch,
          scaleY:
            1 -
            MAX_MANTLE_VERTICAL_COMPRESSION * squash +
            MAX_MANTLE_VERTICAL_ELONGATION * stretch,
          translateY:
            MAX_MANTLE_DOWNWARD_TRANSLATION * squash -
            MAX_MANTLE_UPWARD_TRANSLATION * stretch,
        };

  return { arms, mantle, active };
}

function frameFromState({
  state,
  config,
  sampleDeltaSeconds = 0,
  integratedDeltaSeconds = 0,
  resetReason = null,
}: {
  state: OctoScrollPhysicsState;
  config: OctoScrollPhysicsConfig;
  sampleDeltaSeconds?: number;
  integratedDeltaSeconds?: number;
  resetReason?: OctoScrollPhysicsResetReason | null;
}): OctoScrollPhysicsFrame {
  return {
    state,
    deformation: getOctoScrollDeformation(state, config),
    sampleDeltaSeconds,
    integratedDeltaSeconds,
    scrollVelocityPxPerSecond: state.scrollVelocityPxPerSecond,
    scrollAccelerationPxPerSecondSquared: state.scrollAccelerationPxPerSecondSquared,
    bodyScreenVelocityPxPerSecond: -state.scrollVelocityPxPerSecond,
    resetReason,
  };
}

function discontinuityFrame(
  input: OctoScrollPhysicsInput,
  reason: OctoScrollPhysicsResetReason,
  config: OctoScrollPhysicsConfig,
): OctoScrollPhysicsFrame {
  const state = reason === "invalid-input" ? createOctoScrollPhysicsState() : initializedState(input);
  return frameFromState({ state, config, resetReason: reason });
}

function integrateArm({
  arm,
  dynamics,
  externalForce,
  deltaSeconds,
  config,
}: {
  arm: OctoScrollArmState;
  dynamics: ArmDynamics;
  externalForce: number;
  deltaSeconds: number;
  config: OctoScrollPhysicsConfig;
}): OctoScrollArmState {
  const stepCount = Math.max(1, Math.ceil(deltaSeconds / config.maxSubstepSeconds));
  const stepSeconds = deltaSeconds / stepCount;
  const scalarLimit = config.maxTipOffsetSvg / Math.hypot(1, dynamics.lateralCoupling);
  let offsetSvg = arm.offsetSvg;
  let velocitySvgPerSecond = arm.velocitySvgPerSecond;

  for (let step = 0; step < stepCount; step += 1) {
    const accelerationSvgPerSecondSquared =
      externalForce * dynamics.response -
      config.springStiffnessPerSecondSquared * dynamics.stiffness * offsetSvg -
      config.springDampingPerSecond * dynamics.damping * velocitySvgPerSecond;
    velocitySvgPerSecond += accelerationSvgPerSecondSquared * stepSeconds;
    offsetSvg += velocitySvgPerSecond * stepSeconds;

    if (Math.abs(offsetSvg) > scalarLimit) {
      offsetSvg = clamp(offsetSvg, -scalarLimit, scalarLimit);
      if (Math.sign(velocitySvgPerSecond) === Math.sign(offsetSvg)) {
        velocitySvgPerSecond = 0;
      }
    }
  }

  return { offsetSvg, velocitySvgPerSecond };
}

/**
 * Advances the model by one timestamped scroll sample.
 *
 * Position samples are smoothed to remove trackpad/touch quantization. Explicit
 * kinematics are trusted (then clamped), allowing an integration layer to supply
 * its own filtered velocity and acceleration.
 */
export function stepOctoScrollPhysics(
  state: OctoScrollPhysicsState,
  input: OctoScrollPhysicsInput,
  overrides?: Partial<OctoScrollPhysicsConfig>,
): OctoScrollPhysicsFrame {
  const config = resolveConfig(overrides);
  if (!isValidInput(input)) {
    return discontinuityFrame(input, "invalid-input", config);
  }
  if (!state.initialized || state.lastTimeMs === null) {
    return frameFromState({ state: initializedState(input), config });
  }
  if (state.inputMode !== input.kind) {
    return discontinuityFrame(input, "input-mode-change", config);
  }

  const elapsedMs = input.timeMs - state.lastTimeMs;
  if (elapsedMs < 0) {
    return discontinuityFrame(input, "time-reversal", config);
  }
  if (elapsedMs === 0) {
    return frameFromState({ state, config });
  }
  if (elapsedMs > config.discontinuityGapMs) {
    return discontinuityFrame(input, "sample-gap", config);
  }

  const sampleDeltaSeconds = elapsedMs / 1_000;
  let scrollVelocityPxPerSecond: number;
  let scrollAccelerationPxPerSecondSquared: number;
  let lastScrollPositionPx: number | null = null;

  if (input.kind === "position") {
    const previousPosition = state.lastScrollPositionPx;
    if (previousPosition === null) {
      return discontinuityFrame(input, "input-mode-change", config);
    }
    const positionDeltaPx = input.scrollPositionPx - previousPosition;
    if (Math.abs(positionDeltaPx) > config.maxPositionJumpPx) {
      return discontinuityFrame(input, "position-jump", config);
    }
    const rawVelocity = clamp(
      positionDeltaPx / sampleDeltaSeconds,
      -config.maxScrollVelocityPxPerSecond,
      config.maxScrollVelocityPxPerSecond,
    );
    const smoothing = 1 - Math.exp(-sampleDeltaSeconds / config.positionVelocitySmoothingSeconds);
    scrollVelocityPxPerSecond =
      state.scrollVelocityPxPerSecond +
      (rawVelocity - state.scrollVelocityPxPerSecond) * smoothing;
    scrollAccelerationPxPerSecondSquared = clamp(
      (scrollVelocityPxPerSecond - state.scrollVelocityPxPerSecond) / sampleDeltaSeconds,
      -config.maxScrollAccelerationPxPerSecondSquared,
      config.maxScrollAccelerationPxPerSecondSquared,
    );
    lastScrollPositionPx = input.scrollPositionPx;
  } else {
    scrollVelocityPxPerSecond = clamp(
      input.scrollVelocityPxPerSecond,
      -config.maxScrollVelocityPxPerSecond,
      config.maxScrollVelocityPxPerSecond,
    );
    scrollAccelerationPxPerSecondSquared = clamp(
      input.scrollAccelerationPxPerSecondSquared ??
        (scrollVelocityPxPerSecond - state.scrollVelocityPxPerSecond) / sampleDeltaSeconds,
      -config.maxScrollAccelerationPxPerSecondSquared,
      config.maxScrollAccelerationPxPerSecondSquared,
    );
  }

  const integratedDeltaSeconds = Math.min(sampleDeltaSeconds, config.maxFrameDeltaSeconds);
  // A deceleration sample describes the scroll position settling, not a new pull
  // in the opposite direction. Let the limb spring carry that momentum instead of
  // injecting a second, visually flipped kick while the scroll velocity decays.
  const reinforcingAcceleration =
    Math.sign(scrollVelocityPxPerSecond) ===
    Math.sign(scrollAccelerationPxPerSecondSquared)
      ? scrollAccelerationPxPerSecondSquared
      : 0;
  // The sticky body acts as the anchor moved by the user's scroll gesture. Loose
  // tentacle ends trail that gesture, so drag and the reinforcing acceleration
  // kick use the inverse sign: scroll down lifts the tips; scroll up stretches down.
  const externalForce = -(
    scrollVelocityPxPerSecond * config.velocityDrag +
    reinforcingAcceleration * config.accelerationKick
  );
  const arms = state.arms.map((arm, index) =>
    integrateArm({
      arm,
      dynamics: ARM_DYNAMICS[index],
      externalForce,
      deltaSeconds: integratedDeltaSeconds,
      config,
    }),
  );
  const nextState: OctoScrollPhysicsState = {
    initialized: true,
    inputMode: input.kind,
    lastTimeMs: input.timeMs,
    lastScrollPositionPx,
    scrollVelocityPxPerSecond,
    scrollAccelerationPxPerSecondSquared,
    arms,
  };

  return frameFromState({
    state: nextState,
    config,
    sampleDeltaSeconds,
    integratedDeltaSeconds,
  });
}
