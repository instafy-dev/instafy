import {
  LEARNED_BLOCKS_PREFIX,
  LEARNED_INDEX_PATH,
} from "./projectMemoryPromotion";
import type { RobotBehaviorDefinition, RobotBehaviorId } from "./embodiedAgents";

async function loadControllerClient() {
  return (
    await import(
      "@instafy/frontend/feature-api/controller"
    )
  ).controllerClient;
}

export interface RobotBehaviorScaleOverride {
  headPoseScale?: number;
  baseVelocityScale?: number;
}

export interface RobotBehaviorGuidance {
  motionStyle?: "gentle" | "standard";
  defaultHeadPoseScale?: number;
  defaultBaseVelocityScale?: number;
  behaviorScales?: Partial<Record<RobotBehaviorId, RobotBehaviorScaleOverride>>;
  sourceBlocks?: string[];
}

function clampScale(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.min(1.5, Math.max(0.1, numeric));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeGuidance(value: unknown): RobotBehaviorGuidance | null {
  if (!isRecord(value)) {
    return null;
  }

  const behaviorScales = isRecord(value.behaviorScales)
    ? Object.fromEntries(
        Object.entries(value.behaviorScales)
          .map(([behaviorId, override]) => {
            if (!isRecord(override)) {
              return null;
            }
            const headPoseScale = clampScale(override.headPoseScale);
            const baseVelocityScale = clampScale(override.baseVelocityScale);
            if (headPoseScale == null && baseVelocityScale == null) {
              return null;
            }
            return [
              behaviorId,
              {
                ...(headPoseScale != null ? { headPoseScale } : {}),
                ...(baseVelocityScale != null ? { baseVelocityScale } : {}),
              },
            ] as const;
          })
          .filter(
            (
              entry,
            ): entry is readonly [string, RobotBehaviorScaleOverride] => entry !== null,
          ),
      )
    : undefined;

  const normalized: RobotBehaviorGuidance = {
    ...(value.motionStyle === "gentle" || value.motionStyle === "standard"
      ? { motionStyle: value.motionStyle }
      : {}),
    ...(clampScale(value.defaultHeadPoseScale) != null
      ? { defaultHeadPoseScale: clampScale(value.defaultHeadPoseScale) }
      : {}),
    ...(clampScale(value.defaultBaseVelocityScale) != null
      ? { defaultBaseVelocityScale: clampScale(value.defaultBaseVelocityScale) }
      : {}),
    ...(behaviorScales && Object.keys(behaviorScales).length > 0 ? { behaviorScales } : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function extractGuidanceFromCodeBlocks(markdown: string): RobotBehaviorGuidance | null {
  const matches = markdown.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g);
  for (const match of matches) {
    const info = (match[1] ?? "").toLowerCase();
    if (
      !info.includes("robot-guidance") &&
      !info.includes("robot_behavior_guidance") &&
      !info.includes("robot-behavior-guidance")
    ) {
      continue;
    }
    try {
      const parsed = JSON.parse(match[2] ?? "");
      const normalized = normalizeGuidance(parsed);
      if (normalized) {
        return normalized;
      }
    } catch {
      // ignore invalid guidance blocks
    }
  }
  return null;
}

function extractGuidanceFromComment(markdown: string): RobotBehaviorGuidance | null {
  const match = markdown.match(/<!--\s*robot_behavior_guidance:\s*([\s\S]*?)\s*-->/i);
  if (!match?.[1]) {
    return null;
  }
  try {
    return normalizeGuidance(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

function extractGuidanceFromHeuristics(markdown: string): RobotBehaviorGuidance | null {
  const normalized = markdown.toLowerCase();
  const mentionsGentleWake =
    (normalized.includes("gentle") || normalized.includes("gently")) &&
    (normalized.includes("wake up") || normalized.includes("wake-up"));
  if (!mentionsGentleWake) {
    return null;
  }
  return {
    motionStyle: "gentle",
    behaviorScales: {
      wake_up: {
        headPoseScale: 0.6,
      },
    },
  };
}

export function extractRobotBehaviorGuidanceFromMarkdown(
  markdown: string,
): RobotBehaviorGuidance | null {
  return (
    extractGuidanceFromComment(markdown) ??
    extractGuidanceFromCodeBlocks(markdown) ??
    extractGuidanceFromHeuristics(markdown)
  );
}

function mergeBehaviorGuidance(
  existing: RobotBehaviorGuidance | null,
  incoming: RobotBehaviorGuidance | null,
  sourceBlock?: string,
): RobotBehaviorGuidance | null {
  if (!incoming) {
    return existing;
  }
  const merged: RobotBehaviorGuidance = {
    ...(existing ?? {}),
    ...incoming,
    behaviorScales: {
      ...(existing?.behaviorScales ?? {}),
      ...(incoming.behaviorScales ?? {}),
    },
    sourceBlocks: [
      ...new Set([...(existing?.sourceBlocks ?? []), ...(incoming.sourceBlocks ?? []), ...(sourceBlock ? [sourceBlock] : [])]),
    ],
  };
  return merged;
}

function listLearnedRobotBlockNames(indexContent: string): string[] {
  return [...indexContent.matchAll(/\(blocks\/([a-z0-9][a-z0-9-]*)\/SKILL\.md\)/gi)].map(
    (match) => match[1],
  );
}

export async function loadRobotBehaviorGuidanceFromProjectMemory(options: {
  projectId?: string | null;
  runtimeId?: string | null;
}): Promise<RobotBehaviorGuidance | null> {
  const projectId = options.projectId?.trim();
  if (!projectId) {
    return null;
  }
  const controllerClient = await loadControllerClient();

  const indexFile = await controllerClient.workspace.files.read({
    projectId,
    path: LEARNED_INDEX_PATH,
    runtimeId: options.runtimeId ?? null,
  });
  const indexContent = typeof indexFile?.contentText === "string" ? indexFile.contentText : "";
  if (!indexContent.trim()) {
    return null;
  }

  const blockNames = listLearnedRobotBlockNames(indexContent).slice(0, 8);
  let merged: RobotBehaviorGuidance | null = null;

  for (const blockName of blockNames) {
    const blockFile = await controllerClient.workspace.files.read({
      projectId,
      path: `${LEARNED_BLOCKS_PREFIX}${blockName}/SKILL.md`,
      runtimeId: options.runtimeId ?? null,
    });
    const blockContent = typeof blockFile?.contentText === "string" ? blockFile.contentText : "";
    if (!blockContent.trim()) {
      continue;
    }
    merged = mergeBehaviorGuidance(
      merged,
      extractRobotBehaviorGuidanceFromMarkdown(blockContent),
      blockName,
    );
  }

  return merged;
}

function scaleNumber(value: unknown, scale: number): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return value;
  }
  return Math.round(value * scale * 1000) / 1000;
}

export function applyRobotBehaviorGuidance(
  behavior: RobotBehaviorDefinition,
  guidance: RobotBehaviorGuidance | null | undefined,
): RobotBehaviorDefinition {
  if (!guidance) {
    return behavior;
  }

  const perBehavior = guidance.behaviorScales?.[behavior.id];
  const headPoseScale =
    perBehavior?.headPoseScale ??
    guidance.defaultHeadPoseScale ??
    (guidance.motionStyle === "gentle" ? 0.6 : 1);
  const baseVelocityScale =
    perBehavior?.baseVelocityScale ??
    guidance.defaultBaseVelocityScale ??
    (guidance.motionStyle === "gentle" ? 0.75 : 1);

  const steps = behavior.steps.map((step) => {
    const command = { ...step.command };
    if (command.name === "set_head_pose") {
      command.head_yaw_deg = scaleNumber(command.head_yaw_deg, headPoseScale);
      command.head_pitch_deg = scaleNumber(command.head_pitch_deg, headPoseScale);
      command.head_elbow_deg = scaleNumber(command.head_elbow_deg, headPoseScale);
    }
    if (command.name === "set_base_twist") {
      command.linear_velocity_mps = scaleNumber(command.linear_velocity_mps, baseVelocityScale);
      command.angular_velocity_dps = scaleNumber(command.angular_velocity_dps, baseVelocityScale);
    }
    return {
      ...step,
      command,
      ...(guidance.motionStyle === "gentle" && typeof step.delayMs === "number"
        ? { delayMs: Math.round(step.delayMs * 1.25) }
        : {}),
    };
  });

  return {
    ...behavior,
    steps,
  };
}
