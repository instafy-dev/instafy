import { describe, expect, it } from "vitest";

import {
  DEFAULT_OCTO_SCROLL_PHYSICS_CONFIG,
  createOctoScrollPhysicsState,
  getOctoScrollDeformation,
  resetOctoScrollPhysicsState,
  stepOctoScrollPhysics,
  type OctoScrollPhysicsFrame,
  type OctoScrollPhysicsState,
} from "../octoScrollPhysics";

const FRAME_MS = 1_000 / 60;

function simulatePositionScroll({
  durationSeconds,
  velocityPxPerSecond,
}: {
  durationSeconds: number;
  velocityPxPerSecond: number;
}): OctoScrollPhysicsFrame {
  let state = createOctoScrollPhysicsState();
  let frame = stepOctoScrollPhysics(state, {
    kind: "position",
    timeMs: 0,
    scrollPositionPx: 200,
  });
  state = frame.state;
  const frameCount = Math.round((durationSeconds * 1_000) / FRAME_MS);
  for (let index = 1; index <= frameCount; index += 1) {
    const timeMs = index * FRAME_MS;
    frame = stepOctoScrollPhysics(state, {
      kind: "position",
      timeMs,
      scrollPositionPx: 200 + velocityPxPerSecond * (timeMs / 1_000),
    });
    state = frame.state;
  }
  return frame;
}

function simulateKinematics({
  frames,
  framesPerSecond,
  velocityPxPerSecond,
}: {
  frames: number;
  framesPerSecond: number;
  velocityPxPerSecond: number;
}): OctoScrollPhysicsFrame {
  const frameMs = 1_000 / framesPerSecond;
  let state = createOctoScrollPhysicsState();
  let frame = stepOctoScrollPhysics(state, {
    kind: "kinematics",
    timeMs: 0,
    scrollVelocityPxPerSecond: velocityPxPerSecond,
    scrollAccelerationPxPerSecondSquared: 0,
  });
  state = frame.state;
  for (let index = 1; index <= frames; index += 1) {
    frame = stepOctoScrollPhysics(state, {
      kind: "kinematics",
      timeMs: index * frameMs,
      scrollVelocityPxPerSecond: velocityPxPerSecond,
      scrollAccelerationPxPerSecondSquared: 0,
    });
    state = frame.state;
  }
  return frame;
}

describe("Octo scroll physics", () => {
  it("starts neutral with every tentacle root fixed", () => {
    const deformation = getOctoScrollDeformation(createOctoScrollPhysicsState());

    expect(deformation.active).toBe(false);
    expect(deformation.arms).toHaveLength(4);
    expect(deformation.mantle).toEqual({
      squash: 0,
      stretch: 0,
      scaleX: 1,
      scaleY: 1,
      translateY: 0,
    });
    for (const arm of deformation.arms) {
      expect(arm.root).toEqual({ x: 0, y: 0 });
      expect(arm.proximal).toEqual({ x: 0, y: 0 });
      expect(arm.middle).toEqual({ x: 0, y: 0 });
      expect(arm.tip).toEqual({ x: 0, y: 0 });
    }
  });

  it("trails tips opposite the scroll gesture in both directions", () => {
    const downwardScroll = simulatePositionScroll({
      durationSeconds: 0.5,
      velocityPxPerSecond: 900,
    });
    const upwardScroll = simulatePositionScroll({
      durationSeconds: 0.5,
      velocityPxPerSecond: -900,
    });

    expect(downwardScroll.bodyScreenVelocityPxPerSecond).toBeLessThan(0);
    expect(upwardScroll.bodyScreenVelocityPxPerSecond).toBeGreaterThan(0);
    for (const arm of downwardScroll.deformation.arms) {
      expect(arm.root).toEqual({ x: 0, y: 0 });
      expect(arm.tip.y).toBeLessThan(0);
    }
    for (const arm of upwardScroll.deformation.arms) {
      expect(arm.root).toEqual({ x: 0, y: 0 });
      expect(arm.tip.y).toBeGreaterThan(0);
    }
    expect(downwardScroll.deformation.mantle.squash).toBe(0);
    expect(downwardScroll.deformation.mantle.stretch).toBeGreaterThan(0);
    expect(downwardScroll.deformation.mantle.scaleX).toBeLessThan(1);
    expect(downwardScroll.deformation.mantle.scaleY).toBeGreaterThan(1);
    expect(downwardScroll.deformation.mantle.translateY).toBeLessThan(0);
    expect(upwardScroll.deformation.mantle.squash).toBeGreaterThan(0);
    expect(upwardScroll.deformation.mantle.stretch).toBe(0);
    expect(upwardScroll.deformation.mantle.scaleX).toBeGreaterThan(1);
    expect(upwardScroll.deformation.mantle.scaleY).toBeLessThan(1);
    expect(upwardScroll.deformation.mantle.translateY).toBeGreaterThan(0);
  });

  it("adds an acceleration kick beyond sustained velocity drag", () => {
    const baseline = stepOctoScrollPhysics(createOctoScrollPhysicsState(), {
      kind: "kinematics",
      timeMs: 0,
      scrollVelocityPxPerSecond: 0,
      scrollAccelerationPxPerSecondSquared: 0,
    }).state;
    const dragOnly = stepOctoScrollPhysics(baseline, {
      kind: "kinematics",
      timeMs: FRAME_MS,
      scrollVelocityPxPerSecond: 800,
      scrollAccelerationPxPerSecondSquared: 0,
    });
    const withKick = stepOctoScrollPhysics(baseline, {
      kind: "kinematics",
      timeMs: FRAME_MS,
      scrollVelocityPxPerSecond: 800,
      scrollAccelerationPxPerSecondSquared: 12_000,
    });

    expect(withKick.deformation.arms[0].tip.y).toBeLessThan(
      dragOnly.deformation.arms[0].tip.y,
    );
    expect(withKick.state.arms[0].velocitySvgPerSecond).toBeLessThan(
      dragOnly.state.arms[0].velocitySvgPerSecond,
    );
  });

  it("does not turn braking after a scroll flick into an opposite-direction kick", () => {
    let state = resetOctoScrollPhysicsState({
      kind: "position",
      timeMs: 0,
      scrollPositionPx: 200,
    });
    const tipSamples: number[] = [];
    for (let index = 1; index <= 18; index += 1) {
      const frame = stepOctoScrollPhysics(state, {
        kind: "position",
        timeMs: index * FRAME_MS,
        scrollPositionPx: 260,
      });
      state = frame.state;
      tipSamples.push(frame.deformation.arms[0].tip.y);
    }

    expect(Math.min(...tipSamples)).toBeLessThan(-0.05);
    expect(Math.max(...tipSamples)).toBeLessThanOrEqual(0);
  });

  it("maintains velocity drag and settles back to neutral after motion stops", () => {
    let frame = simulateKinematics({
      frames: 60,
      framesPerSecond: 60,
      velocityPxPerSecond: 1_000,
    });
    expect(frame.deformation.arms[0].tip.y).toBeLessThan(-2);

    let state = frame.state;
    for (let index = 61; index <= 300; index += 1) {
      frame = stepOctoScrollPhysics(state, {
        kind: "kinematics",
        timeMs: index * FRAME_MS,
        scrollVelocityPxPerSecond: 0,
        scrollAccelerationPxPerSecondSquared: 0,
      });
      state = frame.state;
    }

    expect(frame.deformation.active).toBe(false);
    expect(frame.deformation.mantle).toEqual({
      squash: 0,
      stretch: 0,
      scaleX: 1,
      scaleY: 1,
      translateY: 0,
    });
    for (const arm of frame.deformation.arms) {
      expect(Math.abs(arm.tip.y)).toBeLessThan(0.01);
    }
  });

  it("is stable across common animation frame rates", () => {
    const at60Fps = simulateKinematics({
      frames: 60,
      framesPerSecond: 60,
      velocityPxPerSecond: 1_100,
    });
    const at120Fps = simulateKinematics({
      frames: 120,
      framesPerSecond: 120,
      velocityPxPerSecond: 1_100,
    });

    at60Fps.deformation.arms.forEach((arm, index) => {
      expect(arm.tip.y).toBeCloseTo(at120Fps.deformation.arms[index].tip.y, 2);
    });
  });

  it("bounds every output and gives the arms subtly distinct responses", () => {
    const frame = simulateKinematics({
      frames: 60,
      framesPerSecond: 60,
      velocityPxPerSecond: 100_000,
    });
    const tipYs = frame.deformation.arms.map((arm) => arm.tip.y);

    expect(new Set(tipYs.map((value) => value.toFixed(3))).size).toBeGreaterThan(1);
    for (const arm of frame.deformation.arms) {
      expect(Math.hypot(arm.tip.x, arm.tip.y)).toBeLessThanOrEqual(
        DEFAULT_OCTO_SCROLL_PHYSICS_CONFIG.maxTipOffsetSvg,
      );
      expect(Math.hypot(arm.middle.x, arm.middle.y)).toBeLessThan(
        Math.hypot(arm.tip.x, arm.tip.y),
      );
      expect(Math.hypot(arm.proximal.x, arm.proximal.y)).toBeLessThan(
        Math.hypot(arm.middle.x, arm.middle.y),
      );
    }
  });

  it("bounds the directional mantle squash under an extreme upward scroll", () => {
    const frame = simulateKinematics({
      frames: 60,
      framesPerSecond: 60,
      velocityPxPerSecond: -100_000,
    });

    expect(frame.deformation.mantle.squash).toBe(1);
    expect(frame.deformation.mantle.stretch).toBe(0);
    expect(frame.deformation.mantle.scaleX).toBeGreaterThan(1);
    expect(frame.deformation.mantle.scaleX).toBeLessThanOrEqual(1.1);
    expect(frame.deformation.mantle.scaleY).toBeGreaterThanOrEqual(0.85);
    expect(frame.deformation.mantle.scaleY).toBeLessThan(1);
    expect(frame.deformation.mantle.translateY).toBeGreaterThan(0);
    expect(frame.deformation.mantle.translateY).toBeLessThanOrEqual(1);
  });

  it("bounds the subtle mantle elongation under an extreme downward scroll", () => {
    const frame = simulateKinematics({
      frames: 60,
      framesPerSecond: 60,
      velocityPxPerSecond: 100_000,
    });

    expect(frame.deformation.mantle.squash).toBe(0);
    expect(frame.deformation.mantle.stretch).toBe(1);
    expect(frame.deformation.mantle.scaleX).toBeGreaterThanOrEqual(0.95);
    expect(frame.deformation.mantle.scaleX).toBeLessThan(1);
    expect(frame.deformation.mantle.scaleY).toBeGreaterThan(1);
    expect(frame.deformation.mantle.scaleY).toBeLessThanOrEqual(1.06);
    expect(frame.deformation.mantle.translateY).toBeGreaterThanOrEqual(-0.15);
    expect(frame.deformation.mantle.translateY).toBeLessThan(0);
  });

  it("clamps delayed frames and clears motion on input discontinuities", () => {
    let state = simulateKinematics({
      frames: 12,
      framesPerSecond: 60,
      velocityPxPerSecond: 1_000,
    }).state;
    const delayed = stepOctoScrollPhysics(state, {
      kind: "kinematics",
      timeMs: (12 * 1_000) / 60 + 100,
      scrollVelocityPxPerSecond: 1_000,
      scrollAccelerationPxPerSecondSquared: 0,
    });
    expect(delayed.sampleDeltaSeconds).toBeCloseTo(0.1);
    expect(delayed.integratedDeltaSeconds).toBe(
      DEFAULT_OCTO_SCROLL_PHYSICS_CONFIG.maxFrameDeltaSeconds,
    );

    state = delayed.state;
    const afterGap = stepOctoScrollPhysics(state, {
      kind: "kinematics",
      timeMs: (12 * 1_000) / 60 + 400,
      scrollVelocityPxPerSecond: 1_000,
      scrollAccelerationPxPerSecondSquared: 0,
    });
    expect(afterGap.resetReason).toBe("sample-gap");
    expect(afterGap.deformation.active).toBe(false);

    const positionBaseline = resetOctoScrollPhysicsState({
      kind: "position",
      timeMs: 1_000,
      scrollPositionPx: 100,
    });
    const afterJump = stepOctoScrollPhysics(positionBaseline, {
      kind: "position",
      timeMs: 1_016,
      scrollPositionPx: 2_000,
    });
    expect(afterJump.resetReason).toBe("position-jump");
    expect(afterJump.deformation.active).toBe(false);
  });

  it("resets safely for time reversal, invalid input, and input-mode changes", () => {
    const moving = simulateKinematics({
      frames: 20,
      framesPerSecond: 60,
      velocityPxPerSecond: 1_000,
    });
    const reversedTime = stepOctoScrollPhysics(moving.state, {
      kind: "kinematics",
      timeMs: 1,
      scrollVelocityPxPerSecond: 1_000,
    });
    expect(reversedTime.resetReason).toBe("time-reversal");
    expect(reversedTime.deformation.active).toBe(false);

    const invalid = stepOctoScrollPhysics(moving.state, {
      kind: "kinematics",
      timeMs: Number.NaN,
      scrollVelocityPxPerSecond: 1_000,
    });
    expect(invalid.resetReason).toBe("invalid-input");
    expect(invalid.state.initialized).toBe(false);

    const changedMode = stepOctoScrollPhysics(moving.state, {
      kind: "position",
      timeMs: moving.state.lastTimeMs! + FRAME_MS,
      scrollPositionPx: 300,
    });
    expect(changedMode.resetReason).toBe("input-mode-change");
    expect(changedMode.deformation.active).toBe(false);
  });

  it("produces identical output for identical input sequences", () => {
    const run = (): OctoScrollPhysicsState => {
      let state = createOctoScrollPhysicsState();
      const positions = [100, 104, 111, 123, 138, 150, 157, 160, 160, 160];
      positions.forEach((scrollPositionPx, index) => {
        state = stepOctoScrollPhysics(state, {
          kind: "position",
          timeMs: index * FRAME_MS,
          scrollPositionPx,
        }).state;
      });
      return state;
    };

    expect(run()).toEqual(run());
  });
});
