import {
  BEHAVIORS,
  COMMAND_NAMES,
  COMMAND_NAME_SET_HEAD_POSE,
  COMMAND_NAME_STOP_ALL_MOTION,
  JOINTS,
  POSES,
  SKILLS,
  type KnoshSkill,
  type KnoshSkillCommandArg,
} from "../../contract/knoshContract.generated.js";

export type RobotCommand = Record<string, unknown>;
export type RobotBehaviorId = string;

export type RobotBehaviorStep = {
  label: string;
  command: RobotCommand;
  delayMs?: number;
};

export type RobotBehaviorDefinition = {
  id: RobotBehaviorId;
  contractSkillId?: string;
  title: string;
  summary: string;
  promptExamples: string[];
  steps: RobotBehaviorStep[];
};

export type ContractSkillRegistration = {
  skillId: string;
  behaviorId: RobotBehaviorId;
  title: string;
  summary: string;
  safetyClass: string;
  promptExamples: readonly string[];
  promptPatterns: readonly RegExp[];
  arguments: Readonly<Record<string, number | string>>;
  behavior: RobotBehaviorDefinition | null;
  unavailableReason: string | null;
};

type ContractSkillPresentation = {
  behaviorId: RobotBehaviorId;
  promptExamples: readonly string[];
  promptPatterns: readonly RegExp[];
  resolveArguments: (
    prompt: string,
    skill: KnoshSkill,
  ) => Record<string, number | string>;
};

// This is deliberately limited to host-facing wording and deterministic prompt
// routing. Skill titles/descriptions/safety, command names, poses, timings and
// executable steps all come from @knosh/contract.
const CONTRACT_SKILL_PRESENTATION: Readonly<
  Record<string, ContractSkillPresentation>
> = Object.freeze({
  wake: {
    behaviorId: "wake_up",
    promptExamples: ["wake up", "wake and look at me"],
    promptPatterns: [/\bwake(?:\s+up)?\b/i, /\brise\b/i],
    resolveArguments: () => ({}),
  },
  sleep: {
    behaviorId: "sleep",
    promptExamples: ["go to sleep", "rest"],
    promptPatterns: [/\bsleep\b/i, /\brest\b/i, /\bpower down\b/i],
    resolveArguments: () => ({}),
  },
  look_at: {
    behaviorId: "look_at_user",
    promptExamples: ["look at me", "orient to user"],
    promptPatterns: [
      /\blook at (?:me|the user|user|us)\b/i,
      /\borient(?: to)? (?:me|the user|user)\b/i,
    ],
    resolveArguments: (_prompt, skill) => ({
      azimuth_deg: 0,
      elevation_deg:
        skill.params.find((param) => param.name === "elevation_deg")?.default ??
        0,
    }),
  },
  navigate_to: {
    behaviorId: "navigate_to",
    promptExamples: ["go to a named location"],
    promptPatterns: [],
    resolveArguments: () => ({}),
  },
});

function contractPose(name: string) {
  const pose = POSES.find((candidate) => candidate.name === name);
  if (!pose) {
    throw new Error(`@knosh/contract skill references unknown pose: ${name}`);
  }
  return pose;
}

function commandForPose(name: string): RobotCommand {
  const pose = contractPose(name);
  return {
    name: COMMAND_NAME_SET_HEAD_POSE,
    ...Object.fromEntries(
      Object.entries(pose.jointsDeg).map(([joint, position]) => [
        `${joint}_deg`,
        position,
      ]),
    ),
  };
}

function resolveCommandArgument(
  value: KnoshSkillCommandArg,
  args: Readonly<Record<string, number | string>>,
): number | string {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (!value.startsWith("$")) {
      return value;
    }
    const resolved = args[value.slice(1)];
    if (resolved === undefined) {
      throw new Error(`@knosh/contract skill argument ${value} is unresolved`);
    }
    return resolved;
  }

  const pose = contractPose(value.pose);
  const base = pose.jointsDeg[value.joint];
  if (base === undefined) {
    throw new Error(
      `@knosh/contract pose ${value.pose} has no joint ${value.joint}`,
    );
  }
  const plus = value.plus ? resolveCommandArgument(value.plus, args) : 0;
  if (typeof plus !== "number") {
    throw new Error(
      `@knosh/contract skill offset ${String(value.plus)} is not numeric`,
    );
  }
  const result = base + plus;
  if (!value.clampToLimits) {
    return result;
  }
  const joint = JOINTS.find((candidate) => candidate.name === value.joint);
  if (!joint) {
    throw new Error(`@knosh/contract has no joint ${value.joint}`);
  }
  return Math.min(joint.maxDeg, Math.max(joint.minDeg, result));
}

function compileContractSkill(
  skill: KnoshSkill,
  args: Readonly<Record<string, number | string>>,
): { steps: RobotBehaviorStep[]; unavailableReason: string | null } {
  const steps: RobotBehaviorStep[] = [];
  for (const skillStep of skill.steps) {
    if ("driveTo" in skillStep) {
      return {
        steps: [],
        unavailableReason:
          "requires the Knosh navigation executor; raw client motion is intentionally not synthesized",
      };
    }
    if ("behavior" in skillStep) {
      const behavior = BEHAVIORS.find(
        (candidate) => candidate.name === skillStep.behavior,
      );
      if (!behavior) {
        throw new Error(
          `@knosh/contract skill ${skill.id} references unknown behavior ${skillStep.behavior}`,
        );
      }
      for (const behaviorStep of behavior.steps) {
        steps.push({
          label: `${skill.title}: ${behaviorStep.pose}`,
          command: commandForPose(behaviorStep.pose),
          delayMs: Math.round(behaviorStep.durationS * 1000),
        });
      }
      continue;
    }
    if ("pose" in skillStep) {
      steps.push({
        label: `${skill.title}: ${skillStep.pose}`,
        command: commandForPose(skillStep.pose),
        delayMs: Math.round(skillStep.durationS * 1000),
      });
      continue;
    }
    if (!COMMAND_NAMES.includes(skillStep.command)) {
      throw new Error(
        `@knosh/contract skill ${skill.id} references unknown command ${skillStep.command}`,
      );
    }
    steps.push({
      label: skill.title,
      command: {
        name: skillStep.command,
        ...Object.fromEntries(
          Object.entries(skillStep.args).map(([name, value]) => [
            name,
            resolveCommandArgument(value, args),
          ]),
        ),
      },
    });
  }
  return { steps, unavailableReason: null };
}

function assertContractCoverage() {
  const contractSkillIds = new Set(SKILLS.map((skill) => skill.id));
  for (const skillId of Object.keys(CONTRACT_SKILL_PRESENTATION)) {
    if (!contractSkillIds.has(skillId)) {
      throw new Error(
        `Instafy routing metadata references missing @knosh/contract skill: ${skillId}`,
      );
    }
  }
  for (const behavior of BEHAVIORS) {
    if (
      !SKILLS.some((skill) =>
        skill.steps.some(
          (step) => "behavior" in step && step.behavior === behavior.name,
        ),
      )
    ) {
      throw new Error(
        `@knosh/contract behavior ${behavior.name} has no registered skill`,
      );
    }
  }
}

export function buildContractSkillRegistry(
  buildPromptExamples: (...examples: string[]) => string[],
) {
  assertContractCoverage();
  const registrations = SKILLS.map((skill): ContractSkillRegistration => {
    const presentation = CONTRACT_SKILL_PRESENTATION[skill.id];
    if (!presentation) {
      throw new Error(
        `@knosh/contract skill ${skill.id} needs reviewed Instafy routing metadata`,
      );
    }
    const args = Object.freeze(presentation.resolveArguments("", skill));
    const compiled = compileContractSkill(skill, args);
    const promptExamples = Object.freeze(
      buildPromptExamples(...presentation.promptExamples),
    );
    const behavior = compiled.unavailableReason
      ? null
      : Object.freeze({
          id: presentation.behaviorId,
          contractSkillId: skill.id,
          title: skill.title,
          summary: skill.description,
          promptExamples: [...promptExamples],
          steps: compiled.steps,
        });
    return Object.freeze({
      skillId: skill.id,
      behaviorId: presentation.behaviorId,
      title: skill.title,
      summary: skill.description,
      safetyClass: skill.safetyClass,
      promptExamples,
      promptPatterns: presentation.promptPatterns,
      arguments: args,
      behavior,
      unavailableReason: compiled.unavailableReason,
    });
  });

  const stopBehavior: RobotBehaviorDefinition = Object.freeze({
    id: "stop",
    title: "Stop",
    summary: "Immediately stop current robot motion.",
    promptExamples: buildPromptExamples("stop", "freeze"),
    steps: [
      {
        label: "Stop all motion",
        command: { name: COMMAND_NAME_STOP_ALL_MOTION },
      },
    ],
  });

  return Object.freeze({
    registrations: Object.freeze(registrations),
    behaviors: Object.freeze(
      Object.fromEntries([
        ...registrations.flatMap((registration) =>
          registration.behavior
            ? [[registration.behavior.id, registration.behavior] as const]
            : [],
        ),
        [stopBehavior.id, stopBehavior] as const,
      ]),
    ) as Readonly<Record<RobotBehaviorId, RobotBehaviorDefinition>>,
  });
}

export const STOP_PROMPT_PATTERNS = Object.freeze([
  /\bstop\b/i,
  /\bfreeze\b/i,
  /\bhalt\b/i,
]);
