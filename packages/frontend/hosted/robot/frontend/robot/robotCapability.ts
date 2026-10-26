import type {
  CapabilityDefinition,
  CapabilityExecutionFailure,
  CapabilityExecutionResult,
  CapabilityExecutor,
  CapabilityInvocation,
} from "@instafy/sdk/capabilities";
import {
  type ActiveRobotLearningSession,
  type EmbodiedAgentHandle,
  type LearningSessionPlan,
  type ResolvedEmbodiedBehavior,
  type RobotBehaviorId,
  type RobotCommand,
  getPreferredEmbodiedAgentProfile,
  resolveEmbodiedBehaviorPrompt,
} from "./embodiedAgents";
import {
  applyRobotBehaviorGuidance,
  type RobotBehaviorGuidance,
} from "./learnedBehaviorGuidance";
import {
  ROBOT_EMBODIMENT_ACTIONS,
  ROBOT_EMBODIMENT_CAPABILITY_ID,
} from "./robotCapabilityMetadata";

export interface RobotEmbodimentInvocationInput {
  prompt: string;
  selectedHandle: EmbodiedAgentHandle;
  activeLearningSession?: ActiveRobotLearningSession | null;
  behaviorGuidance?: RobotBehaviorGuidance | null;
}

export interface RobotEmbodimentInvocation
  extends CapabilityInvocation<RobotEmbodimentInvocationInput> {
  capabilityId: typeof ROBOT_EMBODIMENT_CAPABILITY_ID;
  actionId: "perform_behavior";
}

export interface RobotEmbodimentExecutionValue {
  resolution: ResolvedEmbodiedBehavior;
  behaviorId: RobotBehaviorId | null;
  coachingNote: string | null;
  executedStepCount: number;
  mode: "behavior" | "learning_session";
  learningSession: LearningSessionPlan | null;
  learningSessionState: "active" | "ended" | null;
}

export interface RobotEmbodimentExecutorContext {
  previewCommand?: (command: RobotCommand) => void;
  runCommand: (command: RobotCommand) => Promise<boolean>;
  onStatus?: (text: string) => void;
  onCapabilityEvent?: (event: Record<string, unknown>) => void;
  refreshLearnDraft?: () => Promise<void>;
}

export const ROBOT_EMBODIMENT_CAPABILITY: CapabilityDefinition = {
  id: ROBOT_EMBODIMENT_CAPABILITY_ID,
  title: "Robot embodiment",
  description: "Allows an agent to resolve embodied robot behaviors onto the Knosh transport surface.",
  actions: ROBOT_EMBODIMENT_ACTIONS,
  promptContext: {
    summary: "Translate user requests into safe high-level robot behaviors routed over the Knosh control surface.",
    instructions: [
      "Use only contract-backed skills such as wake up, look at user, and sleep, plus the direct emergency stop.",
      "If the user is teaching or practicing, enter a coached learning session first and capture richer diagnostics instead of pretending the behavior is already solved.",
      "Keep outputs at the level of robot intent or typed robot commands rather than raw servo pulses.",
      "Use the minimum motion needed to satisfy the request and keep the robot understandable.",
    ],
    constraints: [
      "Do not invent unsupported behaviors or claim access to sensors or actuators that are not exposed.",
      "Leave low-level safety, limits, and failsafes to the robot/controller boundary.",
      "If the request is ambiguous or unsafe, ask for clarification or decline instead of guessing.",
    ],
    examples: (() => {
      const mentionToken = getPreferredEmbodiedAgentProfile()?.displayName ?? "@assistant";
      return [
        `${mentionToken} wake up`,
        `${mentionToken} look at me`,
        `${mentionToken} stop`,
        `${mentionToken} I want to help you learn how to walk`,
      ];
    })(),
  },
};

function sleep(delayMs: number) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

function buildFailure(
  resolution: ResolvedEmbodiedBehavior,
  actionId: RobotEmbodimentInvocation["actionId"],
): CapabilityExecutionFailure {
  const code =
    resolution.status === "missing_capability" ? "missing_capability" : "unknown_behavior";

  return {
    ok: false,
    capabilityId: ROBOT_EMBODIMENT_CAPABILITY_ID,
    actionId,
    error: resolution.detail,
    code,
  };
}

export function createRobotEmbodimentExecutor(
  context: RobotEmbodimentExecutorContext,
): CapabilityExecutor<RobotEmbodimentInvocation, RobotEmbodimentExecutionValue> {
  return {
    capabilityId: ROBOT_EMBODIMENT_CAPABILITY_ID,
    async execute(invocation): Promise<CapabilityExecutionResult<RobotEmbodimentExecutionValue>> {
      const resolution = resolveEmbodiedBehaviorPrompt(
        invocation.input.prompt,
        invocation.input.selectedHandle,
        invocation.input.activeLearningSession ?? null,
      );
      const resolvedBehavior =
        resolution.status === "ready" && resolution.behavior
          ? applyRobotBehaviorGuidance(
              resolution.behavior,
              invocation.input.behaviorGuidance ?? null,
            )
          : resolution.behavior;
      const effectiveResolution =
        resolvedBehavior === resolution.behavior
          ? resolution
          : {
              ...resolution,
              behavior: resolvedBehavior,
            };

      if (effectiveResolution.status === "learning_ready" && effectiveResolution.learningSession) {
        context.onStatus?.(
          `Prepared ${effectiveResolution.agent.displayName} learning session -> ${effectiveResolution.learningSession.goal}`,
        );
        context.onCapabilityEvent?.({
          kind: "capability_invocation",
          agent_handle: effectiveResolution.agent.handle,
          capability_id: ROBOT_EMBODIMENT_CAPABILITY_ID,
          action_id: invocation.actionId,
          status: "learning_ready",
          prompt: invocation.input.prompt,
          learning_goal: effectiveResolution.learningSession.goal,
          diagnostics_level: effectiveResolution.learningSession.diagnosticsLevel,
          consolidation: effectiveResolution.learningSession.consolidation,
        });
        return {
          ok: true,
          capabilityId: ROBOT_EMBODIMENT_CAPABILITY_ID,
          actionId: invocation.actionId,
          value: {
            resolution: effectiveResolution,
            behaviorId: null,
            coachingNote: null,
            executedStepCount: 0,
            mode: "learning_session",
            learningSession: effectiveResolution.learningSession,
            learningSessionState: "active",
          },
        };
      }

      if (effectiveResolution.status === "learning_correction" && effectiveResolution.learningSession) {
        context.onStatus?.(
          `Logged ${effectiveResolution.agent.displayName} coaching note -> ${effectiveResolution.learningSession.goal}`,
        );
        context.onCapabilityEvent?.({
          kind: "capability_invocation",
          agent_handle: effectiveResolution.agent.handle,
          capability_id: ROBOT_EMBODIMENT_CAPABILITY_ID,
          action_id: invocation.actionId,
          status: "learning_correction",
          prompt: invocation.input.prompt,
          learning_goal: effectiveResolution.learningSession.goal,
          coaching_note: effectiveResolution.coachingNote,
          diagnostics_level: effectiveResolution.learningSession.diagnosticsLevel,
          consolidation: effectiveResolution.learningSession.consolidation,
        });
        await context.refreshLearnDraft?.();
        return {
          ok: true,
          capabilityId: ROBOT_EMBODIMENT_CAPABILITY_ID,
          actionId: invocation.actionId,
          value: {
            resolution: effectiveResolution,
            behaviorId: null,
            coachingNote: effectiveResolution.coachingNote,
            executedStepCount: 0,
            mode: "learning_session",
            learningSession: effectiveResolution.learningSession,
            learningSessionState: "active",
          },
        };
      }

      if (effectiveResolution.status === "learning_complete" && effectiveResolution.learningSession) {
        context.onStatus?.(
          `Completed ${effectiveResolution.agent.displayName} learning session -> ${effectiveResolution.learningSession.goal}`,
        );
        context.onCapabilityEvent?.({
          kind: "capability_invocation",
          agent_handle: effectiveResolution.agent.handle,
          capability_id: ROBOT_EMBODIMENT_CAPABILITY_ID,
          action_id: invocation.actionId,
          status: "learning_complete",
          prompt: invocation.input.prompt,
          learning_goal: effectiveResolution.learningSession.goal,
          diagnostics_level: effectiveResolution.learningSession.diagnosticsLevel,
          consolidation: effectiveResolution.learningSession.consolidation,
        });
        await context.refreshLearnDraft?.();
        return {
          ok: true,
          capabilityId: ROBOT_EMBODIMENT_CAPABILITY_ID,
          actionId: invocation.actionId,
          value: {
            resolution: effectiveResolution,
            behaviorId: null,
            coachingNote: null,
            executedStepCount: 0,
            mode: "learning_session",
            learningSession: effectiveResolution.learningSession,
            learningSessionState: "ended",
          },
        };
      }

      if (effectiveResolution.status !== "ready" || !effectiveResolution.behavior) {
        context.onStatus?.("Embodied action not ready");
        context.onCapabilityEvent?.({
          kind: "capability_invocation",
          agent_handle: effectiveResolution.agent.handle,
          capability_id: ROBOT_EMBODIMENT_CAPABILITY_ID,
          action_id: invocation.actionId,
          status: effectiveResolution.status,
          prompt: invocation.input.prompt,
        });
        return buildFailure(effectiveResolution, invocation.actionId);
      }

      context.onStatus?.(
        `Executing ${effectiveResolution.agent.displayName} -> ${effectiveResolution.behavior.title}`,
      );
      context.onCapabilityEvent?.({
        kind: "capability_invocation",
        agent_handle: effectiveResolution.agent.handle,
        capability_id: ROBOT_EMBODIMENT_CAPABILITY_ID,
          action_id: invocation.actionId,
          behavior_id: effectiveResolution.behavior.id,
          status: "started",
          prompt: invocation.input.prompt,
          step_count: effectiveResolution.behavior.steps.length,
          learning_goal: effectiveResolution.learningSession?.goal ?? null,
          diagnostics_level: effectiveResolution.learningSession?.diagnosticsLevel ?? null,
        });

      try {
        let executedStepCount = 0;
        for (const step of effectiveResolution.behavior.steps) {
          context.onStatus?.(`${effectiveResolution.behavior.title}: ${step.label}`);
          context.previewCommand?.(step.command);

          const succeeded = await context.runCommand(step.command);
          if (!succeeded) {
            throw new Error(`Transport step failed: ${step.label}`);
          }

          executedStepCount += 1;
          if (step.delayMs) {
            await sleep(step.delayMs);
          }
        }

        context.onCapabilityEvent?.({
          kind: "capability_invocation",
          agent_handle: effectiveResolution.agent.handle,
          capability_id: ROBOT_EMBODIMENT_CAPABILITY_ID,
          action_id: invocation.actionId,
          behavior_id: effectiveResolution.behavior.id,
          status: "completed",
          prompt: invocation.input.prompt,
          learning_goal: effectiveResolution.learningSession?.goal ?? null,
          diagnostics_level: effectiveResolution.learningSession?.diagnosticsLevel ?? null,
        });

        context.onStatus?.(
          `Completed ${effectiveResolution.agent.displayName} -> ${effectiveResolution.behavior.title}`,
        );
        await context.refreshLearnDraft?.();

        return {
          ok: true,
          capabilityId: ROBOT_EMBODIMENT_CAPABILITY_ID,
          actionId: invocation.actionId,
          value: {
            resolution: effectiveResolution,
            behaviorId: effectiveResolution.behavior.id,
            coachingNote: null,
            executedStepCount,
            mode: "behavior",
            learningSession: effectiveResolution.learningSession,
            learningSessionState: effectiveResolution.learningSession ? "active" : null,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.onStatus?.("Embodied action failed");
        context.onCapabilityEvent?.({
          kind: "capability_invocation",
          agent_handle: effectiveResolution.agent.handle,
          capability_id: ROBOT_EMBODIMENT_CAPABILITY_ID,
          action_id: invocation.actionId,
          behavior_id: effectiveResolution.behavior.id,
          status: "failed",
          prompt: invocation.input.prompt,
          error: message,
          learning_goal: effectiveResolution.learningSession?.goal ?? null,
          diagnostics_level: effectiveResolution.learningSession?.diagnosticsLevel ?? null,
        });

        return {
          ok: false,
          capabilityId: ROBOT_EMBODIMENT_CAPABILITY_ID,
          actionId: invocation.actionId,
          error: message,
          code: "execution_failed",
        };
      }
    },
  };
}
