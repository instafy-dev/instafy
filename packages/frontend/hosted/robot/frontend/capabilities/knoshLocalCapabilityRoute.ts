import {
  createCapabilityExecutorRegistry,
  executeCapabilityInvocation,
} from "@instafy/sdk/capabilities";
import type { ProviderExecutionContext } from "@instafy/provider-contract";
import type { LocalProviderSummary } from "@instafy/frontend/feature-api";
import type {
  LocalCapabilityRouteDefinition,
  LocalCapabilityRouteExecuteOptions,
  LocalCapabilityRouteMatcherOptions,
} from "@instafy/frontend/feature-api";
import {
  postLearnDraft,
  postProbe,
  postSessionEvents,
  type LearnDraftPayload,
  type ProfileUpdateSummary,
  type RobotBackend,
} from "../robot/bridgeClient";
import {
  ROBOT_EMBODIMENT_CAPABILITY,
  createRobotEmbodimentExecutor,
  type RobotEmbodimentExecutorContext,
  type RobotEmbodimentExecutionValue,
} from "../robot/robotCapability";
import {
  createActiveRobotLearningSession,
  resolveEmbodiedBehaviorPrompt,
  type ActiveRobotLearningSession,
} from "../robot/embodiedAgents";
import {
  buildProbeLearningSessionEvents,
  createLearningCorrectionEvent,
  createLearningSessionEndedEvent,
  createLearningSessionStartedEvent,
  deriveActiveRobotLearningSessionFromMessages,
} from "../robot/sessionArtifacts";
import { loadRobotBehaviorGuidanceFromProjectMemory } from "../robot/learnedBehaviorGuidance";
import {
  DEFAULT_RUNTIME_ROBOT_BACKEND,
  DEFAULT_RUNTIME_ROBOT_TARGET,
} from "../robot/runtimeDefaults";

interface LocalCapabilityLearningArtifacts {
  sessionPath?: string;
  appendedCount?: number;
  profileUpdate?: ProfileUpdateSummary | null;
  learnDraft?: LearnDraftPayload | null;
  error?: string | null;
}

function readActiveLearningSession(value: unknown): ActiveRobotLearningSession | null {
  return value && typeof value === "object" ? (value as ActiveRobotLearningSession) : null;
}

async function persistRobotLearningArtifacts(options: {
  sessionId: string;
  learningEvents: Record<string, unknown>[];
  providerId?: string | null;
  provider?: LocalProviderSummary | null;
  executionContext?: ProviderExecutionContext | null;
  onStatus?: (status: string) => void;
}): Promise<LocalCapabilityLearningArtifacts> {
  if (options.learningEvents.length === 0) {
    return {
      profileUpdate: null,
      learnDraft: null,
      error: null,
    };
  }

  options.onStatus?.("Refreshing robot learning artifacts…");

  try {
    const sessionResponse = await postSessionEvents({
      sessionId: options.sessionId,
      events: options.learningEvents,
      executionContext: options.executionContext ?? undefined,
      applyProfileUpdate: true,
    }, {
      providerId: options.providerId,
      provider: options.provider,
    });

    try {
      const learnDraftResponse = await postLearnDraft({
        sessionPath: sessionResponse.sessionPath,
      }, {
        providerId: options.providerId,
        provider: options.provider,
      });
      return {
        sessionPath: sessionResponse.sessionPath,
        appendedCount: sessionResponse.appendedCount,
        profileUpdate: sessionResponse.profileUpdate ?? null,
        learnDraft: learnDraftResponse.value ?? null,
        error: null,
      };
    } catch (error) {
      return {
        sessionPath: sessionResponse.sessionPath,
        appendedCount: sessionResponse.appendedCount,
        profileUpdate: sessionResponse.profileUpdate ?? null,
        learnDraft: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } catch (error) {
    return {
      profileUpdate: null,
      learnDraft: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function canHandleRobotPrompt(options: LocalCapabilityRouteMatcherOptions) {
  const resolution = resolveEmbodiedBehaviorPrompt(
    options.prompt,
    options.handle,
    readActiveLearningSession(options.conversationState) ?? null,
  );
  return resolution.status !== "missing_capability" && resolution.status !== "unknown_behavior";
}

async function executeRobotLocalCapabilityPrompt(
  options: LocalCapabilityRouteExecuteOptions,
): Promise<LocalCapabilityRuntimeResult> {
  const providerId = options.resolvedProviderId?.trim();
  const provider = options.resolvedProvider ?? null;
  if (!providerId) {
    return {
      handled: true,
      responseText: `${options.assistantDefinition.displayName} cannot find a robot provider for that action right now.`,
      error: "No robot provider was resolved for robot embodiment.",
      metadata: {
        kind: "local_capability_result",
        assistant: {
          handle: options.assistantDefinition.handle,
          displayName: options.assistantDefinition.displayName,
        },
        capability: {
          id: ROBOT_EMBODIMENT_CAPABILITY.id,
          status: "failed",
          code: "provider_unavailable",
        },
        localCapability: {
          id: ROBOT_EMBODIMENT_CAPABILITY.id,
          status: "failed",
        },
      },
    };
  }
  const robotBackend = DEFAULT_RUNTIME_ROBOT_BACKEND;
  const robotTarget = DEFAULT_RUNTIME_ROBOT_TARGET;
  const preResolution = resolveEmbodiedBehaviorPrompt(
    options.prompt,
    options.handle,
    readActiveLearningSession(options.conversationState) ?? null,
  );
  const sessionMode = preResolution.learningSession
    ? (options.learningMode ?? options.runtimeMode)
    : options.runtimeMode;
  const transportEvents: Record<string, unknown>[] = [];
  const capabilityEvents: Record<string, unknown>[] = [];
  const learningEvents: Record<string, unknown>[] = [];
  let latestProbeExecutionContext: ProviderExecutionContext | null =
    null;
  const behaviorGuidance = await loadRobotBehaviorGuidanceFromProjectMemory({
    projectId: options.projectId ?? null,
  });
  const learningSessionStartEvent = createLearningSessionStartedEvent({
    prompt: options.prompt,
    resolution: preResolution,
    sessionId: options.sessionId,
    mode: sessionMode,
  });
  if (learningSessionStartEvent) {
    learningEvents.push(learningSessionStartEvent);
  }
  const learningCorrectionEvent = createLearningCorrectionEvent({
    prompt: options.prompt,
    resolution: preResolution,
    sessionId: options.sessionId,
    mode: sessionMode,
  });
  if (learningCorrectionEvent) {
    learningEvents.push(learningCorrectionEvent);
  }
  const learningSessionEndedEvent = createLearningSessionEndedEvent({
    prompt: options.prompt,
    resolution: preResolution,
    sessionId: options.sessionId,
    mode: sessionMode,
  });
  if (learningSessionEndedEvent) {
    learningEvents.push(learningSessionEndedEvent);
  }

  const registry = createCapabilityExecutorRegistry([
    createRobotEmbodimentExecutor({
      runCommand: async (command) => {
        const response = await postProbe(
          {
            backend: robotBackend,
            tcpTarget: robotTarget,
            readStatus: true,
            drainPending: true,
            sessionId: options.sessionId,
            commandJson: command,
            skipCommand: false,
          },
          {
            providerId,
            provider,
            projectId: options.projectId ?? null,
          },
        );
        latestProbeExecutionContext =
          response.executionContext ?? latestProbeExecutionContext;
        transportEvents.push(...(response.events ?? []));
        learningEvents.push(
          ...buildProbeLearningSessionEvents({
            command,
            events: response.events ?? [],
            backend: robotBackend,
            sessionId: options.sessionId,
            mode: sessionMode,
          }),
        );
        return response.connected === true;
      },
      onStatus: options.onStatus,
      onCapabilityEvent: (event) => {
        capabilityEvents.push(event);
        options.onCapabilityEvent?.(event);
      },
    } satisfies RobotEmbodimentExecutorContext),
  ]);

  const result = await executeCapabilityInvocation<RobotEmbodimentExecutionValue>(registry, {
    capabilityId: ROBOT_EMBODIMENT_CAPABILITY.id,
    actionId: "perform_behavior",
    input: {
      prompt: options.prompt,
      selectedHandle: options.handle,
      activeLearningSession: readActiveLearningSession(options.conversationState) ?? null,
      behaviorGuidance,
    },
    source: "local_runtime",
  });

  const learningArtifacts = await persistRobotLearningArtifacts({
    sessionId: options.sessionId,
    learningEvents,
    providerId,
    provider,
    executionContext: latestProbeExecutionContext,
    onStatus: options.onStatus,
  });
  if (result.ok) {
    const completedBehaviorTitle =
      result.value.resolution.behavior?.title ??
      result.value.learningSession?.goal ??
      result.value.behaviorId ??
      "learning session";
    options.onStatus?.(`Completed ${options.assistantDefinition.displayName} -> ${completedBehaviorTitle}`);
  } else {
    options.onStatus?.("Embodied action failed");
  }

  const nextActiveLearningSession =
    result.ok && result.value.learningSession
      ? result.value.learningSessionState === "ended"
        ? null
        : preResolution.learningSessionSource === "explicit"
          ? createActiveRobotLearningSession(
              result.value.learningSession,
              options.handle,
              options.prompt,
            )
          : readActiveLearningSession(options.conversationState) ??
            createActiveRobotLearningSession(
              result.value.learningSession,
              options.handle,
              options.prompt,
            )
      : readActiveLearningSession(options.conversationState) ?? null;

  if (!result.ok) {
    return {
      handled: true,
      responseText: `${options.assistantDefinition.displayName} could not execute that robot behavior: ${result.error}`,
      error: result.error,
      metadata: {
        kind: "local_capability_result",
        assistant: {
          handle: options.assistantDefinition.handle,
          displayName: options.assistantDefinition.displayName,
        },
        capability: {
          id: ROBOT_EMBODIMENT_CAPABILITY.id,
          actionId: "perform_behavior",
          status: "failed",
          code: result.code ?? null,
        },
        localCapability: {
          id: ROBOT_EMBODIMENT_CAPABILITY.id,
          status: "failed",
        },
        robotTransport: {
          backend: robotBackend,
          target: robotTarget,
          sessionId: options.sessionId,
          transportEventCount: transportEvents.length,
        },
        robotLearning: {
          ...learningArtifacts,
          activeSession: nextActiveLearningSession,
          behaviorGuidance,
          learningEventCount: learningEvents.length,
          sessionState: nextActiveLearningSession ? "active" : null,
        },
        capabilityEvents,
      },
    };
  }

  if (result.value.mode === "learning_session" && result.value.learningSession) {
    const sessionResponseText =
      result.value.learningSessionState === "ended"
        ? `${options.assistantDefinition.displayName} finished the learning session for ${result.value.learningSession.goal}. I refreshed the robot learn draft for review.`
        : result.value.coachingNote
          ? `${options.assistantDefinition.displayName} logged that coaching note for ${result.value.learningSession.goal}: "${result.value.coachingNote}". I will keep capturing richer diagnostics as we continue.`
          : `${options.assistantDefinition.displayName} is ready to learn ${result.value.learningSession.goal}. I will capture richer diagnostics and refresh the robot learn draft as we experiment.`;
    return {
      handled: true,
      responseText: sessionResponseText,
      metadata: {
        kind: "local_capability_result",
        assistant: {
          handle: options.assistantDefinition.handle,
          displayName: options.assistantDefinition.displayName,
        },
        capability: {
          id: ROBOT_EMBODIMENT_CAPABILITY.id,
          actionId: "perform_behavior",
          status:
            result.value.learningSessionState === "ended"
              ? "learning_complete"
              : result.value.coachingNote
                ? "learning_correction"
                : "learning_ready",
          mode: result.value.mode,
        },
        localCapability: {
          id: ROBOT_EMBODIMENT_CAPABILITY.id,
          status: "completed",
        },
        robotTransport: {
          backend: robotBackend,
          target: robotTarget,
          sessionId: options.sessionId,
          transportEventCount: transportEvents.length,
        },
        robotLearning: {
          ...learningArtifacts,
          activeSession: nextActiveLearningSession,
          behaviorGuidance,
          coachingNote: result.value.coachingNote,
          learningEventCount: learningEvents.length,
          learningSession: result.value.learningSession,
          sessionState: result.value.learningSessionState,
        },
        capabilityEvents,
      },
    };
  }

  const behaviorTitle =
    result.value.resolution.behavior?.title ?? result.value.behaviorId ?? "robot behavior";
  return {
    handled: true,
    responseText: `${options.assistantDefinition.displayName} executed ${behaviorTitle.toLowerCase()} on the robot transport.`,
    metadata: {
      kind: "local_capability_result",
      assistant: {
        handle: options.assistantDefinition.handle,
        displayName: options.assistantDefinition.displayName,
      },
      capability: {
        id: ROBOT_EMBODIMENT_CAPABILITY.id,
        actionId: "perform_behavior",
        status: "completed",
        mode: result.value.mode,
        behaviorId: result.value.behaviorId,
        executedStepCount: result.value.executedStepCount,
      },
      localCapability: {
        id: ROBOT_EMBODIMENT_CAPABILITY.id,
        status: "completed",
      },
      robotTransport: {
        backend: robotBackend,
        target: robotTarget,
        sessionId: options.sessionId,
        transportEventCount: transportEvents.length,
      },
      robotLearning: {
        ...learningArtifacts,
        activeSession: nextActiveLearningSession,
        behaviorGuidance,
        learningEventCount: learningEvents.length,
        learningSession: result.value.learningSession,
        sessionState: result.value.learningSessionState,
      },
      capabilityEvents,
    },
  };
}

export const KNOSH_LOCAL_CAPABILITY_ROUTE: LocalCapabilityRouteDefinition = {
  id: "knosh.robot-embodiment",
  capabilityId: ROBOT_EMBODIMENT_CAPABILITY.id,
  requiresLocalProvider: true,
  deriveConversationState: deriveActiveRobotLearningSessionFromMessages,
  resolveConversationHandle(conversationState) {
    return readActiveLearningSession(conversationState)?.agentHandle ?? null;
  },
  buildPromptMetadataPatch(conversationState) {
    const activeSession = readActiveLearningSession(conversationState);
    return activeSession ? { robotLearning: { activeSession } } : null;
  },
  matches: canHandleRobotPrompt,
  execute: executeRobotLocalCapabilityPrompt,
};
