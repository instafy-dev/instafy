import { getEmbodiedAssistantCatalog } from "../agents/embodiedAssistantCatalog";
import type { LocalCapabilityConversationMessage } from "@instafy/frontend/feature-api";
import {
  createActiveRobotLearningSession,
  getDefaultEmbodiedAgentHandle,
  type ActiveRobotLearningSession,
  type ResolvedEmbodiedBehavior,
} from "./embodiedAgents";
import type { RobotBackend, RobotBridgeEvent } from "./bridgeClient";

export type RobotSessionEvent = RobotBridgeEvent;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundToThousandths(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function createRobotSessionEvent(
  kind: string,
  source: "app" | "user",
  mode: string,
  payload: Record<string, unknown>,
  sessionId: string,
): RobotSessionEvent {
  return {
    kind,
    message_id: `${kind}-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    timestamp_ns: Date.now() * 1_000_000,
    session_id: sessionId,
    source,
    mode,
    payload,
  };
}

export function createLearningSessionStartedEvent(options: {
  prompt: string;
  resolution: ResolvedEmbodiedBehavior;
  sessionId: string;
  mode: string;
}): RobotSessionEvent | null {
  if (
    options.resolution.status !== "learning_ready" ||
    options.resolution.learningSessionSource !== "explicit" ||
    !options.resolution.learningSession
  ) {
    return null;
  }

  return createRobotSessionEvent(
    "learning_session_started",
    "user",
    options.mode,
    {
      agent_handle: options.resolution.agent.handle,
      prompt: options.prompt,
      goal: options.resolution.learningSession.goal,
      diagnostics_level: options.resolution.learningSession.diagnosticsLevel,
      consolidation: options.resolution.learningSession.consolidation,
      behavior_id: options.resolution.behavior?.id ?? null,
    },
    options.sessionId,
  );
}

export function createLearningCorrectionEvent(options: {
  prompt: string;
  resolution: ResolvedEmbodiedBehavior;
  sessionId: string;
  mode: string;
}): RobotSessionEvent | null {
  if (options.resolution.status !== "learning_correction" || !options.resolution.learningSession) {
    return null;
  }

  return createRobotSessionEvent(
    "learning_correction",
    "user",
    options.mode,
    {
      agent_handle: options.resolution.agent.handle,
      prompt: options.prompt,
      goal: options.resolution.learningSession.goal,
      coaching_note: options.resolution.coachingNote,
      diagnostics_level: options.resolution.learningSession.diagnosticsLevel,
      consolidation: options.resolution.learningSession.consolidation,
    },
    options.sessionId,
  );
}

export function createLearningSessionEndedEvent(options: {
  prompt: string;
  resolution: ResolvedEmbodiedBehavior;
  sessionId: string;
  mode: string;
}): RobotSessionEvent | null {
  if (options.resolution.status !== "learning_complete" || !options.resolution.learningSession) {
    return null;
  }

  return createRobotSessionEvent(
    "learning_session_ended",
    "user",
    options.mode,
    {
      agent_handle: options.resolution.agent.handle,
      prompt: options.prompt,
      goal: options.resolution.learningSession.goal,
      diagnostics_level: options.resolution.learningSession.diagnosticsLevel,
      consolidation: options.resolution.learningSession.consolidation,
      reason: "user_requested_end",
    },
    options.sessionId,
  );
}

function latestTelemetryEnvelope(events: RobotBridgeEvent[]) {
  const latestTelemetry = [...events]
    .reverse()
    .find(
      (event) =>
        (event.event === "telemetry" && typeof event.value === "object" && event.value) ||
        event.kind === "telemetry",
    );

  if (!latestTelemetry) {
    return null;
  }

  if (latestTelemetry.event === "telemetry" && typeof latestTelemetry.value === "object" && latestTelemetry.value) {
    return latestTelemetry.value as Record<string, unknown>;
  }

  return latestTelemetry as Record<string, unknown>;
}

export function probeEventsToSessionEvents(events: RobotBridgeEvent[]): RobotSessionEvent[] {
  return events.flatMap((event) => {
    if (event.event === "telemetry" && typeof event.value === "object" && event.value) {
      return [event.value as RobotSessionEvent];
    }
    if (event.kind === "telemetry") {
      return [event];
    }
    return [];
  });
}

function inferResponseScale(requested: unknown, observed: unknown, minMagnitude: number) {
  const requestedValue = toFiniteNumber(requested);
  if (Math.abs(requestedValue) < minMagnitude) {
    return null;
  }

  const observedValue = toFiniteNumber(observed);
  const scale = clamp(Math.abs(observedValue) / Math.abs(requestedValue), 0.2, 1.5);
  return roundToThousandths(scale);
}

function inferHeadPoseFromTelemetry(telemetry: Record<string, unknown>) {
  const pose =
    typeof telemetry.pose === "object" && telemetry.pose
      ? (telemetry.pose as Record<string, unknown>)
      : null;

  if (!pose) {
    return null;
  }

  return {
    yaw: toFiniteNumber(pose.yaw_deg),
    pitch: toFiniteNumber(pose.pitch_deg),
    elbow: toFiniteNumber(pose.elbow_deg),
  };
}

export function createAdaptationEventFromProbe(
  command: Record<string, unknown> | undefined,
  events: RobotBridgeEvent[],
  backend: RobotBackend,
  sessionId: string,
  mode: string,
): RobotSessionEvent | null {
  if (!command) {
    return null;
  }

  const telemetry = latestTelemetryEnvelope(events);
  if (!telemetry) {
    return null;
  }

  const learnedAdaptation: Record<string, unknown> = {};

  if (command.name === "set_head_pose") {
    const observedPose = inferHeadPoseFromTelemetry(telemetry);
    if (observedPose) {
      const head: Record<string, unknown> = {};
      const yawScale = inferResponseScale(command.head_yaw_deg, observedPose.yaw, 4);
      const pitchScale = inferResponseScale(command.head_pitch_deg, observedPose.pitch, 3);
      const elbowScale = inferResponseScale(command.head_elbow_deg, observedPose.elbow, 2);

      if (yawScale !== null) {
        head.yaw_response_scale = yawScale;
      }
      if (pitchScale !== null) {
        head.pitch_response_scale = pitchScale;
      }
      if (elbowScale !== null) {
        head.elbow_response_scale = elbowScale;
      }
      if (Object.keys(head).length > 0) {
        head.confidence = 0.2;
        learnedAdaptation.head = head;
      }
    }
  }

  if (command.name === "set_base_twist") {
    const observation =
      typeof telemetry.observation === "object" && telemetry.observation
        ? (telemetry.observation as Record<string, unknown>)
        : null;
    const baseState =
      observation && typeof observation.base_state === "object" && observation.base_state
        ? (observation.base_state as Record<string, unknown>)
        : null;

    if (baseState) {
      const drive: Record<string, unknown> = {};
      const linearScale = inferResponseScale(
        command.linear_velocity_mps,
        baseState.linear_velocity_mps,
        0.03,
      );
      const angularScale = inferResponseScale(
        command.angular_velocity_dps,
        baseState.angular_velocity_dps,
        3,
      );

      if (linearScale !== null) {
        drive.linear_velocity_scale = linearScale;
      }
      if (angularScale !== null) {
        drive.angular_velocity_scale = angularScale;
      }
      if (Object.keys(drive).length > 0) {
        drive.confidence = 0.2;
        learnedAdaptation.drive = drive;
      }
    }
  }

  if (Object.keys(learnedAdaptation).length === 0) {
    return null;
  }

  return createRobotSessionEvent(
    "adaptation_update",
    "app",
    mode,
    {
      backend,
      blend_alpha: 0.25,
      learned_adaptation: learnedAdaptation,
    },
    sessionId,
  );
}

export function buildProbeLearningSessionEvents(options: {
  command?: Record<string, unknown>;
  events: RobotBridgeEvent[];
  backend: RobotBackend;
  sessionId: string;
  mode: string;
}): RobotSessionEvent[] {
  const telemetryEvents = probeEventsToSessionEvents(options.events);
  const adaptationEvent = createAdaptationEventFromProbe(
    options.command,
    options.events,
    options.backend,
    options.sessionId,
    options.mode,
  );
  return adaptationEvent ? [...telemetryEvents, adaptationEvent] : telemetryEvents;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseActiveLearningSession(value: unknown): ActiveRobotLearningSession | null {
  if (!isRecord(value)) {
    return null;
  }
  const goal = typeof value.goal === "string" ? value.goal.trim() : "";
  const agentHandle = getEmbodiedAssistantCatalog().resolveAssistantHandle(
    typeof value.agentHandle === "string" ? value.agentHandle : "",
  );
  const diagnosticsLevel = value.diagnosticsLevel;
  const consolidation = value.consolidation;
  const mode = value.mode;
  const sourcePrompt = typeof value.sourcePrompt === "string" ? value.sourcePrompt : "";
  const startedAtMs = typeof value.startedAtMs === "number" ? value.startedAtMs : Date.now();
  if (!goal || !agentHandle) {
    return null;
  }
  if (
    diagnosticsLevel !== "high" ||
    consolidation !== "auto_draft" ||
    mode !== "coached_experiment"
  ) {
    return null;
  }
  return {
    goal,
    agentHandle,
    diagnosticsLevel,
    consolidation,
    mode,
    sourcePrompt,
    startedAtMs,
    state: "active",
  };
}

export function deriveActiveRobotLearningSessionFromMessages(
  messages: readonly LocalCapabilityConversationMessage[],
): ActiveRobotLearningSession | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = isRecord(messages[index]?.metadata)
      ? (messages[index]?.metadata as Record<string, unknown>)
      : null;
    if (!metadata) {
      continue;
    }
    const robotLearning = isRecord(metadata.robotLearning)
      ? (metadata.robotLearning as Record<string, unknown>)
      : null;
    if (!robotLearning) {
      continue;
    }
    const sessionState = typeof robotLearning.sessionState === "string" ? robotLearning.sessionState : null;
    if (sessionState === "ended") {
      return null;
    }
    const activeSession =
      parseActiveLearningSession(robotLearning.activeSession) ??
      (() => {
        const legacyLearningSession = parseActiveLearningSession(robotLearning.learningSession);
        if (!legacyLearningSession) {
          return null;
        }
        const assistantHandle =
          getEmbodiedAssistantCatalog().resolveAssistantHandle(
            isRecord(metadata.assistant) && typeof metadata.assistant.handle === "string"
              ? metadata.assistant.handle
              : "",
          ) ?? getDefaultEmbodiedAgentHandle();
        const sourcePrompt = messages[index]?.content ?? "";
        return createActiveRobotLearningSession(
          legacyLearningSession,
          assistantHandle,
          sourcePrompt,
          legacyLearningSession,
        );
      })();
    if (activeSession) {
      return activeSession;
    }
  }
  return null;
}
