// Knosh-owned motion choreography for spec-defined poses and behaviors.
// All joint targets and timing come from @knosh/contract; the Instafy host
// only mounts the integration's background bridge.

import {
  POSES,
  PRIMARY_CONTROL_UPDATE_RATE_HZ,
} from "../../contract/knoshContract.generated.js";

export type HeadPoseDeg = {
  yawDeg: number;
  pitchDeg: number;
  elbowDeg: number;
};

export type BehaviorStepPlan = {
  poseName: string;
  faceMood: string | null;
  durationS: number;
  target: HeadPoseDeg;
};

export type BehaviorWaypoint = HeadPoseDeg & { atS: number };

const JOINT_KEYS: Record<keyof HeadPoseDeg, string> = {
  yawDeg: "head_yaw",
  pitchDeg: "head_pitch",
  elbowDeg: "head_elbow",
};

export function contractPose(name: string): HeadPoseDeg {
  const pose = POSES.find((candidate) => candidate.name === name);
  if (!pose) {
    throw new Error(`Robot contract has no pose named '${name}'.`);
  }
  return {
    yawDeg: pose.jointsDeg[JOINT_KEYS.yawDeg] ?? 0,
    pitchDeg: pose.jointsDeg[JOINT_KEYS.pitchDeg] ?? 0,
    elbowDeg: pose.jointsDeg[JOINT_KEYS.elbowDeg] ?? 0,
  };
}

/**
 * Expands one behavior step into per-tick waypoints. The final waypoint
 * always lands exactly on the contract target.
 */
export function stepWaypoints(
  from: HeadPoseDeg,
  step: BehaviorStepPlan,
  rateHz: number = PRIMARY_CONTROL_UPDATE_RATE_HZ,
): BehaviorWaypoint[] {
  if (!Number.isFinite(rateHz) || rateHz <= 0) {
    throw new Error(`Waypoint rate must be positive, got ${rateHz}.`);
  }
  const ticks = Math.max(1, Math.ceil(step.durationS * rateHz));
  const waypoints: BehaviorWaypoint[] = [];
  for (let tick = 1; tick <= ticks; tick += 1) {
    const progress = tick / ticks;
    waypoints.push({
      atS: tick / rateHz,
      yawDeg: from.yawDeg + (step.target.yawDeg - from.yawDeg) * progress,
      pitchDeg:
        from.pitchDeg + (step.target.pitchDeg - from.pitchDeg) * progress,
      elbowDeg:
        from.elbowDeg + (step.target.elbowDeg - from.elbowDeg) * progress,
    });
  }
  return waypoints;
}
