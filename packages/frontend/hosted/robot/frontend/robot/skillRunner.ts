// Phone-side executor for spec-owned Knosh skills. The public Instafy core
// supplies only the feature-module mount and provider-request APIs; contract
// data and robot execution stay in this private integration.

import {
  BEHAVIORS,
  JOINTS,
  POSES,
  PRIMARY_CONTROL_UPDATE_RATE_HZ,
  SKILLS,
  type KnoshSkill,
  type KnoshSkillCommandArg,
  type KnoshSkillPostcondition,
  type KnoshSkillPrecondition,
} from "../../contract/knoshContract.generated.js";

import {
  stepWaypoints,
  type BehaviorStepPlan,
  type HeadPoseDeg,
} from "./behaviorPlayer";

export const KNOSH_SKILL_TOOL_PREFIX = "knosh.robot.skill.";

export type SkillRunStatus =
  | "succeeded"
  | "blocked"
  | "failed"
  | "verification_failed";

export type SkillRunResult = {
  skill_id: string;
  status: SkillRunStatus;
  params: Record<string, number | string>;
  timeout_s: number;
  steps_executed: Array<Record<string, unknown>>;
  verification: Array<Record<string, unknown>>;
  blockers: string[];
  next_actions: string[];
};

export type SkillRunnerHooks = {
  sendCommand: (command: Record<string, unknown>) => void | Promise<void>;
  readJointState: () => Promise<Record<string, number>>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const POSTCONDITION_POLL_INTERVAL_MS = 50;

export function isKnoshSkillToolName(
  toolName: string | null | undefined,
): boolean {
  return (
    typeof toolName === "string" &&
    toolName.startsWith(KNOSH_SKILL_TOOL_PREFIX)
  );
}

export function skillIdFromToolName(toolName: string): string | null {
  return isKnoshSkillToolName(toolName)
    ? toolName.slice(KNOSH_SKILL_TOOL_PREFIX.length)
    : null;
}

export function findContractSkill(skillId: string): KnoshSkill | null {
  return SKILLS.find((skill) => skill.id === skillId) ?? null;
}

function findContractPose(name: string) {
  const pose = POSES.find((candidate) => candidate.name === name);
  if (!pose) {
    throw new Error(`pose '${name}' is not defined in the spec`);
  }
  return pose;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function skillResult(
  skill: KnoshSkill,
  params: Record<string, number | string>,
  status: SkillRunStatus,
  stepsExecuted: Array<Record<string, unknown>>,
  verification: Array<Record<string, unknown>>,
  blockers: string[],
  nextActions: string[],
): SkillRunResult {
  return {
    skill_id: skill.id,
    status,
    params,
    timeout_s: skill.timeoutS,
    steps_executed: stepsExecuted,
    verification,
    blockers,
    next_actions: nextActions,
  };
}

function preconditionPredicateValue(precondition: KnoshSkillPrecondition) {
  return {
    kind: precondition.kind,
    pose: precondition.pose,
    tolerance_deg: precondition.toleranceDeg,
  };
}

function postconditionPredicateValue(postcondition: KnoshSkillPostcondition) {
  if (postcondition.kind === "joint_near") {
    return {
      kind: postcondition.kind,
      joint: postcondition.joint,
      target: postcondition.target,
      tolerance_deg: postcondition.toleranceDeg,
    };
  }
  return {
    kind: postcondition.kind,
    location: postcondition.location,
    tolerance_m: postcondition.toleranceM,
  };
}

function jointsOutsidePose(
  poseName: string,
  toleranceDeg: number,
  observed: Record<string, number>,
): string[] {
  const pose = findContractPose(poseName);
  const offending: string[] = [];
  for (const [joint, target] of Object.entries(pose.jointsDeg)) {
    const position = observed[joint];
    if (typeof position !== "number") {
      offending.push(`${joint} missing from telemetry observation`);
    } else if (Math.abs(position - target) > toleranceDeg) {
      offending.push(
        `${joint} observed ${position} deg vs target ${target} deg (tolerance ${toleranceDeg} deg)`,
      );
    }
  }
  return offending;
}

function evaluatePrecondition(
  precondition: KnoshSkillPrecondition,
  observed: Record<string, number>,
): [boolean, string, string[]] {
  const offending = jointsOutsidePose(
    precondition.pose,
    precondition.toleranceDeg,
    observed,
  );
  if (precondition.kind === "pose_near") {
    if (offending.length === 0) {
      return [true, "", []];
    }
    return [
      false,
      `pose_near '${precondition.pose}': ${offending.join("; ")}`,
      [
        "skill already satisfied? check pose",
        `the robot is not near pose '${precondition.pose}' - read the robot status summary to confirm the current joint state`,
      ],
    ];
  }
  if (offending.length === 0) {
    return [
      false,
      `not_pose_near '${precondition.pose}': every joint is within ${precondition.toleranceDeg} deg of pose '${precondition.pose}'`,
      [
        `the robot is currently near pose '${precondition.pose}'`,
        `if this skill's goal state is pose '${precondition.pose}' it is already satisfied; otherwise run the skill that leaves '${precondition.pose}' (e.g. wake) first`,
      ],
    ];
  }
  return [true, "", []];
}

function resolveNumericParamRef(
  reference: string,
  params: Record<string, number | string>,
): number {
  if (!reference.startsWith("$")) {
    throw new Error(`param reference must start with '$': ${reference}`);
  }
  const name = reference.slice(1);
  const value = params[name];
  if (typeof value !== "number") {
    throw new Error(`numeric param '${name}' was not resolved for this invocation`);
  }
  return value;
}

function resolveCommandArg(
  arg: KnoshSkillCommandArg,
  params: Record<string, number | string>,
): number {
  if (typeof arg === "number") {
    return arg;
  }
  if (typeof arg === "string") {
    return resolveNumericParamRef(arg, params);
  }
  const pose = findContractPose(arg.pose);
  const base = pose.jointsDeg[arg.joint];
  if (typeof base !== "number") {
    throw new Error(`pose '${arg.pose}' does not define joint '${arg.joint}'`);
  }
  const offset = arg.plus ? resolveNumericParamRef(arg.plus, params) : 0;
  let value = base + offset;
  if (arg.clampToLimits) {
    const joint = JOINTS.find((candidate) => candidate.name === arg.joint);
    if (!joint) {
      throw new Error(`joint '${arg.joint}' is not defined in the spec`);
    }
    value = clamp(value, joint.minDeg, joint.maxDeg);
  }
  return value;
}

function resolvePostconditionTarget(
  target: number | string,
  joint: string,
  params: Record<string, number | string>,
): number {
  if (typeof target === "number") {
    return target;
  }
  if (target.startsWith("pose:")) {
    const poseName = target.slice("pose:".length);
    const pose = findContractPose(poseName);
    const value = pose.jointsDeg[joint];
    if (typeof value !== "number") {
      throw new Error(`pose '${poseName}' does not define joint '${joint}'`);
    }
    return value;
  }
  return resolveNumericParamRef(target, params);
}

function poseHeadCommandPayload(poseName: string): Record<string, unknown> {
  const pose = findContractPose(poseName);
  const payload: Record<string, unknown> = { name: "set_head_pose" };
  for (const [joint, target] of Object.entries(pose.jointsDeg)) {
    payload[`${joint}_deg`] = target;
  }
  return payload;
}

function headPoseFromJointState(
  observed: Record<string, number>,
): HeadPoseDeg {
  return {
    yawDeg: observed.head_yaw ?? 0,
    pitchDeg: observed.head_pitch ?? 0,
    elbowDeg: observed.head_elbow ?? 0,
  };
}

function headPoseCommand(pose: HeadPoseDeg): Record<string, unknown> {
  return {
    name: "set_head_pose",
    head_yaw_deg: pose.yawDeg,
    head_pitch_deg: pose.pitchDeg,
    head_elbow_deg: pose.elbowDeg,
  };
}

type StepRuntime = {
  hooks: Required<Pick<SkillRunnerHooks, "sendCommand" | "readJointState">> & {
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  };
  deadlineMs: number;
  currentPose: HeadPoseDeg;
};

async function streamPoseMove(
  runtime: StepRuntime,
  poseName: string,
  durationS: number,
): Promise<number> {
  const pose = findContractPose(poseName);
  const plan: BehaviorStepPlan = {
    poseName,
    faceMood: null,
    durationS,
    target: {
      yawDeg: pose.jointsDeg.head_yaw ?? 0,
      pitchDeg: pose.jointsDeg.head_pitch ?? 0,
      elbowDeg: pose.jointsDeg.head_elbow ?? 0,
    },
  };
  const tickMs = 1000 / PRIMARY_CONTROL_UPDATE_RATE_HZ;
  const waypoints = stepWaypoints(
    runtime.currentPose,
    plan,
    PRIMARY_CONTROL_UPDATE_RATE_HZ,
  );
  let lastLatencyMs = 0;
  for (const waypoint of waypoints) {
    const sentAt = runtime.hooks.now();
    await runtime.hooks.sendCommand(headPoseCommand(waypoint));
    lastLatencyMs = Math.max(0, runtime.hooks.now() - sentAt);
    const waitMs = Math.min(tickMs, runtime.deadlineMs - runtime.hooks.now());
    if (waitMs > 0) {
      await runtime.hooks.sleep(waitMs);
    }
  }
  runtime.currentPose = plan.target;
  return lastLatencyMs;
}

async function executeStep(
  runtime: StepRuntime,
  step: KnoshSkill["steps"][number],
  stepIndex: number,
  params: Record<string, number | string>,
  stepsExecuted: Array<Record<string, unknown>>,
): Promise<void> {
  if ("driveTo" in step) {
    throw new Error(
      "drive_to requires Knosh's navigation executor and is not available through the native skill bridge",
    );
  }

  if ("behavior" in step) {
    const behavior = BEHAVIORS.find(
      (candidate) => candidate.name === step.behavior,
    );
    if (!behavior) {
      throw new Error(`behavior '${step.behavior}' is not defined in the spec`);
    }
    for (const behaviorStep of behavior.steps) {
      const latencyMs = await streamPoseMove(
        runtime,
        behaviorStep.pose,
        behaviorStep.durationS,
      );
      stepsExecuted.push({
        step_index: stepIndex,
        kind: "behavior",
        behavior: step.behavior,
        pose: behaviorStep.pose,
        duration_s: behaviorStep.durationS,
        command: poseHeadCommandPayload(behaviorStep.pose),
        reply_latency_ms: latencyMs,
      });
    }
    return;
  }

  if ("pose" in step) {
    const latencyMs = await streamPoseMove(
      runtime,
      step.pose,
      step.durationS,
    );
    stepsExecuted.push({
      step_index: stepIndex,
      kind: "pose",
      pose: step.pose,
      duration_s: step.durationS,
      command: poseHeadCommandPayload(step.pose),
      reply_latency_ms: latencyMs,
    });
    return;
  }

  const payload: Record<string, unknown> = { name: step.command };
  for (const [argName, arg] of Object.entries(step.args)) {
    payload[argName] = resolveCommandArg(arg, params);
  }
  const sentAt = runtime.hooks.now();
  await runtime.hooks.sendCommand(payload);
  stepsExecuted.push({
    step_index: stepIndex,
    kind: "command",
    command: payload,
    reply_latency_ms: Math.max(0, runtime.hooks.now() - sentAt),
  });
  if (step.command === "set_head_pose") {
    runtime.currentPose = {
      yawDeg:
        typeof payload.head_yaw_deg === "number"
          ? payload.head_yaw_deg
          : runtime.currentPose.yawDeg,
      pitchDeg:
        typeof payload.head_pitch_deg === "number"
          ? payload.head_pitch_deg
          : runtime.currentPose.pitchDeg,
      elbowDeg:
        typeof payload.head_elbow_deg === "number"
          ? payload.head_elbow_deg
          : runtime.currentPose.elbowDeg,
    };
  }
}

function resolveSkillParams(
  skill: KnoshSkill,
  args: Record<string, unknown>,
): {
  params: Record<string, number | string>;
  blockers: string[];
} {
  const params: Record<string, number | string> = {};
  const blockers: string[] = [];

  for (const param of skill.params) {
    const value = args[param.name];
    if (param.kind === "number") {
      if (value !== undefined) {
        if (typeof value === "number" && Number.isFinite(value)) {
          params[param.name] = clamp(value, param.min, param.max);
        } else {
          blockers.push(
            `param ${param.name}: expected a number, got ${JSON.stringify(value)}`,
          );
        }
      } else if (param.default !== null) {
        params[param.name] = clamp(param.default, param.min, param.max);
      } else if (param.required) {
        blockers.push(`param ${param.name}: required but missing`);
      }
      continue;
    }

    if (value !== undefined) {
      if (typeof value !== "string") {
        blockers.push(
          `param ${param.name}: expected one of ${JSON.stringify(param.values)}, got ${JSON.stringify(value)}`,
        );
      } else if (!param.values.includes(value)) {
        blockers.push(
          `param ${param.name}: expected one of ${JSON.stringify(param.values)}, got ${JSON.stringify(value)}`,
        );
      } else {
        params[param.name] = value;
      }
    } else if (param.default !== null) {
      params[param.name] = param.default;
    } else if (param.required) {
      blockers.push(`param ${param.name}: required but missing`);
    }
  }

  for (const key of Object.keys(args)) {
    if (!skill.params.some((param) => param.name === key)) {
      blockers.push(`param ${key}: not declared by skill '${skill.id}'`);
    }
  }
  return { params, blockers };
}

export async function runSkill(
  skillId: string,
  args: Record<string, unknown>,
  hooks: SkillRunnerHooks,
): Promise<SkillRunResult> {
  const skill = findContractSkill(skillId);
  if (!skill) {
    throw new Error(`skill '${skillId}' is not defined in the spec`);
  }

  const { params, blockers: paramBlockers } = resolveSkillParams(skill, args);
  if (paramBlockers.length > 0) {
    return skillResult(skill, params, "failed", [], [], paramBlockers, [
      "fix the arguments to match the tool input schema and retry",
    ]);
  }

  if (skill.steps.some((step) => "driveTo" in step)) {
    return skillResult(
      skill,
      params,
      "failed",
      [],
      [],
      [
        `skill '${skill.id}' requires Knosh's navigation executor, which is not available through the native skill bridge`,
      ],
      [
        "run this skill through a Knosh provider runtime with navigation support",
      ],
    );
  }

  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? defaultSleep;
  const deadlineMs = now() + skill.timeoutS * 1000;
  const verification: Array<Record<string, unknown>> = [];

  let observedJoints: Record<string, number>;
  try {
    observedJoints = await hooks.readJointState();
  } catch (error) {
    return skillResult(
      skill,
      params,
      "failed",
      [],
      [],
      [
        `telemetry probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      ["check that the robot transport backend is running and retry"],
    );
  }

  const preconditionBlockers: string[] = [];
  const preconditionNextActions: string[] = [];
  for (const precondition of skill.preconditions) {
    const [passed, detail, nextActions] = evaluatePrecondition(
      precondition,
      observedJoints,
    );
    verification.push({
      predicate: preconditionPredicateValue(precondition),
      observed: { ...observedJoints },
      passed,
    });
    if (!passed) {
      preconditionBlockers.push(`precondition ${detail}`);
      preconditionNextActions.push(...nextActions);
    }
  }
  if (preconditionBlockers.length > 0) {
    return skillResult(
      skill,
      params,
      "blocked",
      [],
      verification,
      preconditionBlockers,
      preconditionNextActions,
    );
  }

  const runtime: StepRuntime = {
    hooks: {
      sendCommand: hooks.sendCommand,
      readJointState: hooks.readJointState,
      sleep,
      now,
    },
    deadlineMs,
    currentPose: headPoseFromJointState(observedJoints),
  };
  const stepsExecuted: Array<Record<string, unknown>> = [];
  for (let stepIndex = 0; stepIndex < skill.steps.length; stepIndex += 1) {
    if (now() >= deadlineMs) {
      return skillResult(
        skill,
        params,
        "failed",
        stepsExecuted,
        verification,
        [
          `timeout: skill '${skill.id}' exceeded ${skill.timeoutS} s before step ${stepIndex}`,
        ],
        [
          "retry once the robot is idle; steps already sent may have partially applied",
        ],
      );
    }
    try {
      await executeStep(
        runtime,
        skill.steps[stepIndex]!,
        stepIndex,
        params,
        stepsExecuted,
      );
    } catch (error) {
      return skillResult(
        skill,
        params,
        "failed",
        stepsExecuted,
        verification,
        [
          `step ${stepIndex} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
        ["check the robot transport backend and retry"],
      );
    }
  }

  const jointPostconditions = skill.postconditions.filter(
    (
      postcondition,
    ): postcondition is Extract<
      KnoshSkillPostcondition,
      { kind: "joint_near" }
    > => postcondition.kind === "joint_near",
  );
  let postconditionEntries: Array<Record<string, unknown>> = [];
  let allPassed = jointPostconditions.length === 0;
  while (jointPostconditions.length > 0) {
    let polledJoints: Record<string, number>;
    try {
      polledJoints = await hooks.readJointState();
    } catch (error) {
      return skillResult(
        skill,
        params,
        "failed",
        stepsExecuted,
        verification,
        [
          `postcondition telemetry probe failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
        ["check that the robot transport backend is running and retry"],
      );
    }
    postconditionEntries = [];
    allPassed = true;
    for (const postcondition of jointPostconditions) {
      const targetDeg = resolvePostconditionTarget(
        postcondition.target,
        postcondition.joint,
        params,
      );
      const observed = polledJoints[postcondition.joint];
      const passed =
        typeof observed === "number" &&
        Math.abs(observed - targetDeg) <= postcondition.toleranceDeg;
      allPassed = allPassed && passed;
      postconditionEntries.push({
        predicate: postconditionPredicateValue(postcondition),
        target_deg: targetDeg,
        observed: typeof observed === "number" ? observed : null,
        passed,
      });
    }
    if (allPassed || now() >= deadlineMs) {
      break;
    }
    const waitMs = Math.min(
      POSTCONDITION_POLL_INTERVAL_MS,
      Math.max(0, deadlineMs - now()),
    );
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  const failedPostconditions = postconditionEntries
    .filter((entry) => entry.passed === false)
    .map((entry) => {
      const predicate = entry.predicate as {
        joint: string;
        tolerance_deg: number;
      };
      return `postcondition joint_near ${predicate.joint}: observed ${JSON.stringify(entry.observed)} deg, expected ${JSON.stringify(entry.target_deg)} ± ${JSON.stringify(predicate.tolerance_deg)} deg`;
    });
  verification.push(...postconditionEntries);

  if (allPassed) {
    return skillResult(
      skill,
      params,
      "succeeded",
      stepsExecuted,
      verification,
      [],
      [],
    );
  }
  return skillResult(
    skill,
    params,
    "verification_failed",
    stepsExecuted,
    verification,
    failedPostconditions,
    [
      "steps were sent but telemetry never confirmed the target state within the timeout",
      "read the robot status summary to inspect the current joint state before retrying",
    ],
  );
}
