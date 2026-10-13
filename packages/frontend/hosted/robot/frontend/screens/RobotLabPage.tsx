import { useEffect, useMemo, useState } from "react";
import type { ProviderProjectAccessDescriptor } from "@instafy/sdk/provider-project-binding";
import { Link, useLocation } from "react-router-dom";
import {
  createCapabilityRegistry,
  executeCapabilityInvocation,
} from "@instafy/sdk/capabilities";
import { buildLocalCapabilityAssistantPromptContext } from "@instafy/frontend/feature-api/runtime";
import {
  attachProjectProvider,
  resolveProjectProviderAccess,
  type ProjectProviderAccessResolution,
} from "@instafy/frontend/feature-api/runtime";
import {
  getLocalProviderForCapability,
  type LocalProviderSummary,
} from "@instafy/frontend/feature-api/runtime";
import { createLocalCapabilityExecutorRegistry } from "@instafy/frontend/feature-api/runtime";
import type { CapabilityAvailability } from "@instafy/sdk/capabilities";
import { LOCAL_CAPABILITY_DEFINITIONS } from "@instafy/frontend/feature-api/runtime";
import {
  Badge,
  Button,
  Card,
  Heading,
  Input,
  SegmentedControl,
  Select,
  Text,
  Textarea,
  Toggle,
  useProject,
} from "@instafy/frontend/feature-api/ui";
import {
  createActiveRobotLearningSession,
  getDefaultEmbodiedAgentHandle,
  getEmbodiedAgentProfile,
  listEmbodiedAgentProfiles,
  type ActiveRobotLearningSession,
  type EmbodiedAgentHandle,
  type RobotBehaviorStep,
  resolveEmbodiedBehaviorPrompt,
} from "../robot";
import {
  ROBOT_BRIDGE_BASE_URL,
  fetchReplayEvaluation,
  fetchReplayReport,
  fetchRobotProfile,
  type LearnDraftPayload,
  postLearnDraft,
  postProbe,
  postReplayApply,
  postReplayRun,
  postSessionEvents,
  type PersistedRobotProfile,
  type ReplayApplySummary,
  type ReplayEvaluationReport,
  type ReplayHarnessReport,
  type ReplayReportResponse,
  type RobotBackend,
  type RobotBridgeEvent,
} from "../robot";
import {
  ROBOT_EMBODIMENT_FEATURE_SERVICE_ID,
  ROBOT_EMBODIMENT_CAPABILITY,
  type RobotEmbodimentExecutorContext,
  type RobotEmbodimentExecutionValue,
} from "../robot";
import {
  buildProbeLearningSessionEvents,
  createLearningCorrectionEvent,
  createLearningSessionEndedEvent,
  createLearningSessionStartedEvent,
  createRobotSessionEvent,
} from "../robot";
import { promoteRobotLearnDraftToProjectMemory } from "../robot";
import { useStatus } from "@instafy/frontend/feature-api/ui";
import {
  ensureProjectProviderCapability,
} from "@instafy/frontend/feature-api/runtime";
import { applyPageMeta, useWorkspaceTabs } from "@instafy/frontend/feature-api/ui";
import { RobotEventTapeSection } from "./robot-lab/RobotEventTapeSection";
import { RobotCommandDebuggerSection } from "./robot-lab/RobotCommandDebuggerSection";
import { RobotLearnDraftSection } from "./robot-lab/RobotLearnDraftSection";
import { RobotMountedPreviewSection } from "./robot-lab/RobotMountedPreviewSection";
import { RobotReplayAnalysisSection } from "./robot-lab/RobotReplayAnalysisSection";

type MountMode = "mounted" | "handheld";
type OrientationMode = "landscape" | "portrait";
type RobotLabEvent = RobotBridgeEvent;

type UserPreferences = {
  preferredMaxLinearVelocityMps: number;
  preferredMaxAngularVelocityDps: number;
  preferredHeadMotionScale: number;
};

type ReplayDeltaItem = {
  label: string;
  deltaText: string;
  detail: string;
  magnitude: number;
};

const DEFAULT_TARGETS: Record<RobotBackend, string> = {
  virtual_tcp: "127.0.0.1:7777",
  host_ble_emulator: "127.0.0.1:8787",
};
const SESSION_ID = "instafy_robot_lab";

const DEFAULT_PREFERENCES: UserPreferences = {
  preferredMaxLinearVelocityMps: 0.25,
  preferredMaxAngularVelocityDps: 90,
  preferredHeadMotionScale: 1,
};

const KNOSH_PROVIDER_ID = "knosh";
const KNOSH_PROJECT_ACCESS: ProviderProjectAccessDescriptor = {
  required: true,
  purpose: "Store learned robot state, replay reports, and session-derived summaries for Robot Lab.",
  requestedCapabilities: ["project_content_read", "project_content_write"],
  preferredPrefix: ".instafy/providers/knosh/",
};

function isRobotBackend(value: string | null): value is RobotBackend {
  return value === "virtual_tcp" || value === "host_ble_emulator";
}

function parseRobotLabTransportPrefill(search: string) {
  const searchParams = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const backend = searchParams.get("backend");
  const tcpTarget = searchParams.get("tcpTarget")?.trim() ?? "";
  return {
    backend: isRobotBackend(backend) ? backend : null,
    tcpTarget: tcpTarget.length > 0 ? tcpTarget : null,
  };
}
const DEFAULT_COMMANDS = {
  center: {
    name: "set_head_pose",
    head_yaw_deg: 0,
    head_pitch_deg: 0,
    head_elbow_deg: 0,
  },
  lookLeft: {
    name: "set_head_pose",
    head_yaw_deg: 20,
    head_pitch_deg: -4,
    head_elbow_deg: 0,
  },
  lookRight: {
    name: "set_head_pose",
    head_yaw_deg: -20,
    head_pitch_deg: -4,
    head_elbow_deg: 0,
  },
  driveArc: {
    name: "set_base_twist",
    linear_velocity_mps: 0.18,
    angular_velocity_dps: 14,
  },
  stop: {
    name: "stop_all_motion",
  },
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function createLocalSessionEvent(kind: string, source: "app" | "user", mode: string, payload: Record<string, unknown>) {
  return createRobotSessionEvent(kind, source, mode, payload, SESSION_ID);
}

function applyPreferencesToCommand(
  command: Record<string, unknown>,
  preferences: UserPreferences
): Record<string, unknown> {
  if (command.name === "set_base_twist") {
    return {
      ...command,
      linear_velocity_mps: clamp(
        toFiniteNumber(command.linear_velocity_mps),
        -preferences.preferredMaxLinearVelocityMps,
        preferences.preferredMaxLinearVelocityMps
      ),
      angular_velocity_dps: clamp(
        toFiniteNumber(command.angular_velocity_dps),
        -preferences.preferredMaxAngularVelocityDps,
        preferences.preferredMaxAngularVelocityDps
      ),
    };
  }

  if (command.name === "set_head_pose") {
    const scale = preferences.preferredHeadMotionScale;
    const adjusted = { ...command };
    // The current Knosh contract has yaw, pitch, and elbow joints. Strip the
    // retired roll field from saved/custom legacy commands before dispatch.
    delete adjusted.head_roll_deg;
    return {
      ...adjusted,
      head_yaw_deg: roundToTenths(toFiniteNumber(command.head_yaw_deg) * scale),
      head_pitch_deg: roundToTenths(toFiniteNumber(command.head_pitch_deg) * scale),
      head_elbow_deg: roundToTenths(toFiniteNumber(command.head_elbow_deg) * scale),
    };
  }

  return command;
}

function roundToTenths(value: number) {
  return Math.round(value * 10) / 10;
}

function roundToThousandths(value: number) {
  return Math.round(value * 1000) / 1000;
}

function roundToHundredths(value: number) {
  return Math.round(value * 100) / 100;
}

function previewHeadPoseFromCommand(command: Record<string, unknown>) {
  if (command.name !== "set_head_pose") {
    return null;
  }

  return {
    yaw: Number(command.head_yaw_deg || 0),
    pitch: Number(command.head_pitch_deg || 0),
    elbow: Number(command.head_elbow_deg || 0),
  };
}

function describeBehaviorCommand(step: RobotBehaviorStep) {
  const command = step.command;
  if (command.name === "set_head_pose") {
    return `set_head_pose(${Number(command.head_yaw_deg || 0)}°, ${Number(command.head_pitch_deg || 0)}°, ${Number(
      command.head_elbow_deg || 0
    )}°)`;
  }
  if (command.name === "set_base_twist") {
    return `set_base_twist(${Number(command.linear_velocity_mps || 0)} m/s, ${Number(
      command.angular_velocity_dps || 0
    )} deg/s)`;
  }
  return String(command.name || "command");
}

function formatSigned(value: number, digits = 2) {
  const rounded = digits === 3 ? roundToThousandths(value) : roundToHundredths(value);
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function nestedNumber(value: RobotLabEvent | undefined, path: string[]) {
  let current: unknown = value;

  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function buildReplayDeltaItems(report: ReplayHarnessReport) {
  const baseline = report.baseline.learned_adaptation;
  const best = report.best_variant.learned_adaptation;

  if (!baseline || !best) {
    return [] as ReplayDeltaItem[];
  }

  const fields = [
    {
      label: "Yaw response",
      path: ["head", "yaw_response_scale"],
      threshold: 0.02,
      deltaText: (delta: number) => `${formatSigned(delta * 100)}%`,
      detail: (from: number, to: number) => `Head yaw response moved from ${roundToHundredths(from)}x to ${roundToHundredths(to)}x.`,
    },
    {
      label: "Pitch response",
      path: ["head", "pitch_response_scale"],
      threshold: 0.02,
      deltaText: (delta: number) => `${formatSigned(delta * 100)}%`,
      detail: (from: number, to: number) => `Head pitch response moved from ${roundToHundredths(from)}x to ${roundToHundredths(to)}x.`,
    },
    {
      label: "Roll response",
      path: ["head", "roll_response_scale"],
      threshold: 0.02,
      deltaText: (delta: number) => `${formatSigned(delta * 100)}%`,
      detail: (from: number, to: number) => `Head roll response moved from ${roundToHundredths(from)}x to ${roundToHundredths(to)}x.`,
    },
    {
      label: "Left motor trim",
      path: ["drive", "left_motor_trim"],
      threshold: 0.005,
      deltaText: (delta: number) => formatSigned(delta, 3),
      detail: (from: number, to: number) => `Drive trim moved from ${roundToThousandths(from)} to ${roundToThousandths(to)}.`,
    },
    {
      label: "Heading bias",
      path: ["drive", "heading_bias_deg_per_m"],
      threshold: 0.1,
      deltaText: (delta: number) => `${formatSigned(delta)}°/m`,
      detail: (from: number, to: number) =>
        `Heading bias compensation moved from ${roundToHundredths(from)}°/m to ${roundToHundredths(to)}°/m.`,
    },
    {
      label: "Linear drive scale",
      path: ["drive", "linear_velocity_scale"],
      threshold: 0.02,
      deltaText: (delta: number) => `${formatSigned(delta * 100)}%`,
      detail: (from: number, to: number) => `Linear drive scale moved from ${roundToHundredths(from)}x to ${roundToHundredths(to)}x.`,
    },
    {
      label: "Angular drive scale",
      path: ["drive", "angular_velocity_scale"],
      threshold: 0.02,
      deltaText: (delta: number) => `${formatSigned(delta * 100)}%`,
      detail: (from: number, to: number) => `Angular drive scale moved from ${roundToHundredths(from)}x to ${roundToHundredths(to)}x.`,
    },
    {
      label: "Command latency",
      path: ["timing", "command_latency_scale"],
      threshold: 0.02,
      deltaText: (delta: number) => `${formatSigned(delta * 100)}%`,
      detail: (from: number, to: number) => `Latency compensation moved from ${roundToHundredths(from)}x to ${roundToHundredths(to)}x.`,
    },
    {
      label: "Servo settle",
      path: ["timing", "servo_settle_scale"],
      threshold: 0.02,
      deltaText: (delta: number) => `${formatSigned(delta * 100)}%`,
      detail: (from: number, to: number) => `Servo settle timing moved from ${roundToHundredths(from)}x to ${roundToHundredths(to)}x.`,
    },
    {
      label: "Head confidence",
      path: ["head", "confidence"],
      threshold: 0.02,
      deltaText: (delta: number) => formatSigned(delta),
      detail: (from: number, to: number) => `Head adaptation confidence moved from ${roundToHundredths(from)} to ${roundToHundredths(to)}.`,
    },
    {
      label: "Drive confidence",
      path: ["drive", "confidence"],
      threshold: 0.02,
      deltaText: (delta: number) => formatSigned(delta),
      detail: (from: number, to: number) => `Drive adaptation confidence moved from ${roundToHundredths(from)} to ${roundToHundredths(to)}.`,
    },
  ];

  return fields
    .flatMap((field) => {
      const from = nestedNumber(baseline, field.path);
      const to = nestedNumber(best, field.path);
      if (from === null || to === null) {
        return [];
      }

      const delta = to - from;
      if (Math.abs(delta) < field.threshold) {
        return [];
      }

      return [
        {
          label: field.label,
          deltaText: field.deltaText(delta),
          detail: field.detail(from, to),
          magnitude: Math.abs(delta),
        },
      ];
    })
    .sort((left, right) => right.magnitude - left.magnitude)
    .slice(0, 6);
}

function inferHeadPose(events: RobotLabEvent[]) {
  const latestTelemetry = [...events]
    .reverse()
    .find((event) => event.event === "telemetry" || event.kind === "telemetry");

  if (!latestTelemetry) {
    return null;
  }

  const value =
    typeof latestTelemetry.value === "object" && latestTelemetry.value
      ? (latestTelemetry.value as Record<string, unknown>)
      : latestTelemetry;
  const pose =
    typeof value.pose === "object" && value.pose
      ? (value.pose as Record<string, unknown>)
      : null;

  if (!pose) {
    const observation =
      typeof value.observation === "object" && value.observation
        ? (value.observation as Record<string, unknown>)
        : null;
    const jointState = Array.isArray(observation?.joint_state)
      ? (observation.joint_state as Array<Record<string, unknown>>)
      : [];
    if (jointState.length === 0) {
      return null;
    }

    const lookupJoint = (jointName: string) =>
      jointState.find((joint) => joint.joint_name === jointName)?.position_deg;

    return {
      yaw: Number(lookupJoint("head_yaw") || 0),
      pitch: Number(lookupJoint("head_pitch") || 0),
      elbow: Number(lookupJoint("head_elbow") || 0),
    };
  }

  return {
    yaw: typeof pose.head_yaw_deg === "number" ? pose.head_yaw_deg : 0,
    pitch: typeof pose.head_pitch_deg === "number" ? pose.head_pitch_deg : 0,
    elbow: typeof pose.head_elbow_deg === "number" ? pose.head_elbow_deg : 0,
  };
}

function preferencesFromProfile(profile?: PersistedRobotProfile | null): UserPreferences | null {
  const payload = profile?.user_preferences;
  if (!payload) {
    return null;
  }

  return {
    preferredMaxLinearVelocityMps: toFiniteNumber(
      payload.preferred_max_linear_velocity_mps,
      DEFAULT_PREFERENCES.preferredMaxLinearVelocityMps
    ),
    preferredMaxAngularVelocityDps: toFiniteNumber(
      payload.preferred_max_angular_velocity_dps,
      DEFAULT_PREFERENCES.preferredMaxAngularVelocityDps
    ),
    preferredHeadMotionScale: toFiniteNumber(
      payload.preferred_head_motion_scale,
      DEFAULT_PREFERENCES.preferredHeadMotionScale
    ),
  };
}

export function RobotLabPage() {
  const location = useLocation();
  const { activeProjectId, activeProjectName } = useProject();
  const { showStatus } = useStatus();
  const { openPanelTab, requestUrlPush } = useWorkspaceTabs();
  const embodiedAgentProfiles = useMemo(() => listEmbodiedAgentProfiles(), []);
  const defaultEmbodiedAgentHandle = useMemo(() => getDefaultEmbodiedAgentHandle(), []);
  const defaultEmbodiedAgentProfile = useMemo(
    () =>
      getEmbodiedAgentProfile(defaultEmbodiedAgentHandle) ??
      embodiedAgentProfiles[0] ??
      null,
    [defaultEmbodiedAgentHandle, embodiedAgentProfiles],
  );
  const [backend, setBackend] = useState<RobotBackend>("virtual_tcp");
  const [tcpTarget, setTcpTarget] = useState(DEFAULT_TARGETS.virtual_tcp);
  const transportPrefill = useMemo(
    () => parseRobotLabTransportPrefill(location.search),
    [location.search],
  );
  const [mountMode, setMountMode] = useState<MountMode>("mounted");
  const [orientation, setOrientation] = useState<OrientationMode>("landscape");
  const [readStatus, setReadStatus] = useState(true);
  const [drainPending, setDrainPending] = useState(true);
  const [statusText, setStatusText] = useState("Idle");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [statusPayload, setStatusPayload] = useState<RobotLabEvent | null>(null);
  const [events, setEvents] = useState<RobotLabEvent[]>([]);
  const [agentHandle, setAgentHandle] = useState<EmbodiedAgentHandle>(() => defaultEmbodiedAgentHandle);
  const [agentPrompt, setAgentPrompt] = useState(
    () => defaultEmbodiedAgentProfile?.defaultPrompt ?? "@assistant summarize this room log",
  );
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentStatusText, setAgentStatusText] = useState("No embodied behavior queued");
  const [agentErrorText, setAgentErrorText] = useState<string | null>(null);
  const [activeLearningSession, setActiveLearningSession] =
    useState<ActiveRobotLearningSession | null>(null);
  const [customCommand, setCustomCommand] = useState(
    JSON.stringify(DEFAULT_COMMANDS.center, null, 2)
  );
  const [headPose, setHeadPose] = useState({ yaw: 0, pitch: 0, elbow: 0 });
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayStatusText, setReplayStatusText] = useState("No replay analysis loaded");
  const [replayErrorText, setReplayErrorText] = useState<string | null>(null);
  const [replayReport, setReplayReport] = useState<ReplayHarnessReport | null>(null);
  const [replayReportPath, setReplayReportPath] = useState<string | null>(null);
  const [replayEvaluation, setReplayEvaluation] = useState<ReplayEvaluationReport | null>(null);
  const [replayEvaluationPath, setReplayEvaluationPath] = useState<string | null>(null);
  const [replayEvaluationErrorText, setReplayEvaluationErrorText] = useState<string | null>(null);
  const [replayApplySummary, setReplayApplySummary] = useState<ReplayApplySummary | null>(null);
  const [replaySamples, setReplaySamples] = useState(12);
  const [replaySeed, setReplaySeed] = useState(42);
  const [replayApplyLastFrame, setReplayApplyLastFrame] = useState(true);
  const [learnBusy, setLearnBusy] = useState(false);
  const [learnStatusText, setLearnStatusText] = useState("No /learn draft loaded");
  const [learnErrorText, setLearnErrorText] = useState<string | null>(null);
  const [learnDraft, setLearnDraft] = useState<LearnDraftPayload | null>(null);
  const [learnPromotionState, setLearnPromotionState] = useState<"idle" | "saving" | "saved">("idle");
  const [projectProviderAccess, setProjectProviderAccess] =
    useState<ProjectProviderAccessResolution | null>(null);
  const [projectProviderAccessBusy, setProjectProviderAccessBusy] = useState(false);
  const [projectProviderAccessError, setProjectProviderAccessError] = useState<string | null>(null);
  const [projectProviderAttachBusy, setProjectProviderAttachBusy] = useState(false);
  const [activeRobotProvider, setActiveRobotProvider] = useState<LocalProviderSummary | null>(null);
  const [activeRobotProviderError, setActiveRobotProviderError] = useState<string | null>(null);

  useEffect(() => {
    applyPageMeta({
      title: "Robot Lab · Instafy",
      description:
        "Scratch simulation surface for connecting Instafy to the Knosh virtual robot and BLE emulator.",
      image: "/og-image.png",
    });
  }, []);

  useEffect(() => {
    if (!transportPrefill.backend && !transportPrefill.tcpTarget) {
      return;
    }
    if (transportPrefill.backend) {
      setBackend(transportPrefill.backend);
      setTcpTarget(transportPrefill.tcpTarget ?? DEFAULT_TARGETS[transportPrefill.backend]);
      return;
    }
    if (transportPrefill.tcpTarget) {
      setTcpTarget(transportPrefill.tcpTarget);
    }
  }, [transportPrefill.backend, transportPrefill.tcpTarget]);

  const capabilityRegistry = useMemo(
    () => createCapabilityRegistry(LOCAL_CAPABILITY_DEFINITIONS),
    [],
  );
  const robotEmbodimentCapability =
    capabilityRegistry.get(ROBOT_EMBODIMENT_CAPABILITY.id) ?? ROBOT_EMBODIMENT_CAPABILITY;
  const activeRobotProviderId = activeRobotProvider?.id ?? null;
  const activeRobotProviderLabel =
    activeRobotProvider?.title?.trim() || activeRobotProviderId || "embodied provider";
  const robotProviderClientOptions = useMemo(
    () =>
      activeRobotProvider
        ? {
            providerId: activeRobotProvider.id,
            provider: activeRobotProvider,
            projectId: activeProjectId ?? null,
          }
        : undefined,
    [activeProjectId, activeRobotProvider],
  );
  const selectedEmbodiedAgent =
    getEmbodiedAgentProfile(agentHandle) ?? defaultEmbodiedAgentProfile;
  const providerAttachmentHandle =
    selectedEmbodiedAgent?.capabilityEnabled ? selectedEmbodiedAgent.handle : defaultEmbodiedAgentHandle;
  const selectedEmbodiedAgentMentionToken = selectedEmbodiedAgent?.displayName ?? "@assistant";
  const embodiedCapableAgents = useMemo(
    () => embodiedAgentProfiles.filter((profile) => profile.capabilityEnabled),
    [embodiedAgentProfiles],
  );
  const conversationalOnlyAgents = useMemo(
    () => embodiedAgentProfiles.filter((profile) => !profile.capabilityEnabled),
    [embodiedAgentProfiles],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [profileResult, replayResult, evaluationResult, learnDraftResult] = await Promise.allSettled([
        fetchRobotProfile(robotProviderClientOptions),
        fetchReplayReport(robotProviderClientOptions),
        fetchReplayEvaluation(robotProviderClientOptions),
        postLearnDraft({ sessionId: SESSION_ID }, robotProviderClientOptions),
      ]);

      if (cancelled) {
        return;
      }

      if (profileResult.status === "fulfilled") {
        const loadedPreferences = preferencesFromProfile(profileResult.value.value);
        if (loadedPreferences) {
          setPreferences(loadedPreferences);
        }
      }

      if (replayResult.status === "fulfilled") {
        setReplayReport(replayResult.value.report || null);
        setReplayReportPath(replayResult.value.reportPath || null);
        setReplayStatusText(
          replayResult.value.report ? "Loaded latest replay report" : "No replay report yet",
        );
      }

      if (evaluationResult.status === "fulfilled") {
        applyReplayEvaluationResponse(evaluationResult.value);
        setReplayEvaluationErrorText(null);
      } else {
        setReplayEvaluationErrorText(
          evaluationResult.reason instanceof Error
            ? evaluationResult.reason.message
            : String(evaluationResult.reason),
        );
      }

      if (learnDraftResult.status === "fulfilled") {
        setLearnDraft(learnDraftResult.value.value || null);
        setLearnStatusText(
          learnDraftResult.value.value
            ? "Loaded /learn draft from robot artifacts"
            : "No /learn draft loaded",
        );
      } else {
        setLearnDraft(null);
        setLearnStatusText("No /learn draft loaded");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [robotProviderClientOptions]);

  useEffect(() => {
    setLearnPromotionState("idle");
  }, [learnDraft]);

  useEffect(() => {
    let cancelled = false;
    void getLocalProviderForCapability(robotEmbodimentCapability.id)
      .then((provider) => {
        if (!cancelled) {
          setActiveRobotProvider(provider);
          setActiveRobotProviderError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setActiveRobotProvider(null);
          setActiveRobotProviderError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [robotEmbodimentCapability.id]);

  useEffect(() => {
    if (!activeProjectId) {
      setProjectProviderAccess(null);
      setProjectProviderAccessError(null);
      setProjectProviderAccessBusy(false);
      return;
    }
    if (!activeRobotProviderId) {
      setProjectProviderAccess(null);
      setProjectProviderAccessError(null);
      setProjectProviderAccessBusy(false);
      return;
    }

    let cancelled = false;
    setProjectProviderAccessBusy(true);
    setProjectProviderAccessError(null);
    void resolveProjectProviderAccess({
      projectId: activeProjectId,
      providerId: activeRobotProviderId,
      assistantHandle: providerAttachmentHandle,
      capabilityId: robotEmbodimentCapability.id,
    })
      .then((result) => {
        if (!cancelled) {
          setProjectProviderAccess(result);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProjectProviderAccess(null);
          setProjectProviderAccessError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setProjectProviderAccessBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, activeRobotProviderId, providerAttachmentHandle, robotEmbodimentCapability.id]);
  const resolvedEmbodiedAction = useMemo(
    () => resolveEmbodiedBehaviorPrompt(agentPrompt, agentHandle, activeLearningSession),
    [activeLearningSession, agentHandle, agentPrompt]
  );
  const runtimeCapabilityAvailability = useMemo<CapabilityAvailability[]>(() => {
    const entries: CapabilityAvailability[] = [];
    entries.push({
      capabilityId: robotEmbodimentCapability.id,
      status: tcpTarget.trim().length > 0 ? "available" : "unavailable",
      summary:
        tcpTarget.trim().length > 0
          ? `Robot transport is configured through ${backend} at ${tcpTarget}`
          : "Robot transport target is not configured",
      resources: [backend === "virtual_tcp" ? "virtual_robot_transport" : "host_ble_emulator_transport"],
    });
    return entries;
  }, [backend, robotEmbodimentCapability.id, tcpTarget]);
  const selectedAgentPromptContext = useMemo(
    () =>
      buildLocalCapabilityAssistantPromptContext(
        agentHandle,
        LOCAL_CAPABILITY_DEFINITIONS,
        runtimeCapabilityAvailability,
      ) ?? "",
    [agentHandle, runtimeCapabilityAvailability],
  );
  const activeAgentSummary = useMemo(() => {
    const embodiedLabels = embodiedCapableAgents.map((profile) => `\`${profile.displayName}\``);
    const conversationalLabels = conversationalOnlyAgents.map((profile) => `\`${profile.displayName}\``);
    if (embodiedLabels.length === 0) {
      return "No built-in agent currently has robot embodiment enabled.";
    }
    if (conversationalLabels.length === 0) {
      return `${embodiedLabels.join(", ")} can move the robot.`;
    }
    return `${embodiedLabels.join(", ")} can move the robot. ${conversationalLabels.join(", ")} stay conversational unless a hardware capability is explicitly granted.`;
  }, [conversationalOnlyAgents, embodiedCapableAgents]);

  function syncPreferencesFromProfile(profile?: PersistedRobotProfile | null) {
    const loadedPreferences = preferencesFromProfile(profile);
    if (loadedPreferences) {
      setPreferences(loadedPreferences);
    }
  }

  function applyReplayReportResponse(response: ReplayReportResponse) {
    setReplayReport(response.report || null);
    setReplayReportPath(response.reportPath || null);
  }

  function applyReplayEvaluationResponse(response: {
    evaluation?: ReplayEvaluationReport | null;
    evaluationPath?: string;
  }) {
    setReplayEvaluation(response.evaluation || null);
    setReplayEvaluationPath(response.evaluationPath || null);
  }

  function openWorkspaceFile(path: string) {
    if (typeof window === "undefined") {
      return;
    }
    const detail = {
      path,
      source: "robot-lab",
      projectId: activeProjectId ?? null,
      markdownView: "preview" as const,
      preferPreview: true,
    };
    const runtimeWindow = window as typeof window & {
      __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: typeof detail | null;
    };
    runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = detail;
    requestUrlPush();
    openPanelTab("code");
    window.dispatchEvent(new CustomEvent("instafy:open-workspace-file", { detail }));
  }

  const stageTransform = useMemo(() => {
    const yaw = clamp(headPose.yaw, -30, 30);
    const pitch = clamp(headPose.pitch, -20, 20);
    const elbow = clamp(headPose.elbow, -30, 30);
    return {
      shell: "none",
      arm: `rotate(${yaw * 0.22}deg) translateY(${(pitch + elbow) * 0.12}px)`,
      screen: `translate(${yaw * 0.25}px, ${(pitch + elbow) * 0.45}px)`,
      pupilX: `${50 + yaw * 0.55}%`,
      pupilY: `${50 + pitch * 1.2}%`,
    };
  }, [headPose.elbow, headPose.pitch, headPose.yaw]);

  function pushLocalEvent(event: RobotLabEvent) {
    setEvents((previous) => [event, ...previous].slice(0, 16));
  }

  async function ensureKnoshWriteAccess() {
    if (!activeProjectId) {
      throw new Error("Select or create a project before saving Robot Lab state.");
    }
    return ensureProjectProviderCapability({
      projectId: activeProjectId,
      providerId: KNOSH_PROVIDER_ID,
      projectAccess: KNOSH_PROJECT_ACCESS,
      requiredCapability: "project_content_write",
    });
  }

  async function persistSessionEvents(
    nextEvents: RobotLabEvent[],
    executionContext?: import("@instafy/provider-contract").ProviderExecutionContext | null,
  ) {
    const projectBinding = await ensureKnoshWriteAccess();
    const response = await postSessionEvents({
      sessionId: SESSION_ID,
      events: nextEvents,
      executionContext: executionContext ?? undefined,
      applyProfileUpdate: true,
      projectBinding,
    }, robotProviderClientOptions);
    if (response.sessionPath) {
      setSessionPath(response.sessionPath);
    }
    const loadedPreferences = preferencesFromProfile(response.profileUpdate?.profile);
    if (loadedPreferences) {
      setPreferences(loadedPreferences);
    }
    return response;
  }

  async function refreshReplayReport() {
    setReplayBusy(true);
    setReplayErrorText(null);
    setReplayEvaluationErrorText(null);
    try {
      const [reportResponse, evaluationResponse] = await Promise.all([
        fetchReplayReport(robotProviderClientOptions),
        fetchReplayEvaluation(robotProviderClientOptions).catch((error) => {
          setReplayEvaluationErrorText(error instanceof Error ? error.message : String(error));
          applyReplayEvaluationResponse({ evaluation: null, evaluationPath: undefined });
          return null;
        }),
      ]);
      applyReplayReportResponse(reportResponse);
      if (evaluationResponse) {
        applyReplayEvaluationResponse(evaluationResponse);
      }
      setReplayStatusText(
        reportResponse.report ? "Loaded latest replay report" : "No replay report yet",
      );
    } catch (error) {
      setReplayErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setReplayBusy(false);
    }
  }

  async function runReplayAnalysis() {
    setReplayBusy(true);
    setReplayErrorText(null);
    setReplayEvaluationErrorText(null);
    setReplayApplySummary(null);
    try {
      const projectBinding = await ensureKnoshWriteAccess();
      const response = await postReplayRun({
        sessionId: SESSION_ID,
        samples: replaySamples,
        seed: replaySeed,
        applyLastFrame: replayApplyLastFrame,
        projectBinding,
      }, robotProviderClientOptions);
      applyReplayReportResponse(response);
      const evaluationResponse = await fetchReplayEvaluation(robotProviderClientOptions).catch(
        (error) => {
          setReplayEvaluationErrorText(error instanceof Error ? error.message : String(error));
          applyReplayEvaluationResponse({ evaluation: null, evaluationPath: undefined });
          return null;
        },
      );
      if (evaluationResponse) {
        applyReplayEvaluationResponse(evaluationResponse);
      }
      setReplayStatusText("Replay analysis updated from Unity");
      if (response.report?.session_path) {
        setSessionPath(response.report.session_path);
      }
    } catch (error) {
      setReplayErrorText(error instanceof Error ? error.message : String(error));
      setReplayStatusText("Replay analysis failed");
    } finally {
      setReplayBusy(false);
    }
  }

  async function applyReplayRecommendation() {
    setReplayBusy(true);
    setReplayErrorText(null);
    setReplayEvaluationErrorText(null);
    try {
      const projectBinding = await ensureKnoshWriteAccess();
      const response = await postReplayApply({
        sessionId: SESSION_ID,
        projectBinding,
      }, robotProviderClientOptions);
      setReplayApplySummary(response.summary || null);
      setReplayReport(response.report || null);
      setReplayReportPath(response.reportPath || null);
      if (response.summary?.session_path) {
        setSessionPath(response.summary.session_path);
      }
      syncPreferencesFromProfile(response.summary?.profile_update?.profile);
      const evaluationResponse = await fetchReplayEvaluation(robotProviderClientOptions).catch(
        (error) => {
          setReplayEvaluationErrorText(error instanceof Error ? error.message : String(error));
          applyReplayEvaluationResponse({ evaluation: null, evaluationPath: undefined });
          return null;
        },
      );
      if (evaluationResponse) {
        applyReplayEvaluationResponse(evaluationResponse);
      }

      if (!response.summary?.had_recommendation) {
        setReplayStatusText("Replay report has no recommendation to apply");
      } else if (response.summary.skipped_existing_event) {
        setReplayStatusText("Replay recommendation was already imported");
      } else if (response.summary.profile_update?.wrote) {
        setReplayStatusText("Applied replay recommendation to the robot profile");
      } else {
        setReplayStatusText("Imported replay recommendation without changing the profile");
      }
    } catch (error) {
      setReplayErrorText(error instanceof Error ? error.message : String(error));
      setReplayStatusText("Replay recommendation failed");
    } finally {
      setReplayBusy(false);
    }
  }

  async function refreshLearnDraft() {
    setLearnBusy(true);
    setLearnErrorText(null);
    try {
      const response = await postLearnDraft({
        sessionPath: sessionPath || undefined,
      }, robotProviderClientOptions);
      setLearnDraft(response.value || null);
      setLearnStatusText(response.value ? "Loaded /learn draft from robot artifacts" : "No /learn draft loaded");
    } catch (error) {
      setLearnErrorText(error instanceof Error ? error.message : String(error));
      setLearnStatusText("/learn draft failed");
    } finally {
      setLearnBusy(false);
    }
  }

  async function handlePromoteLearnDraft() {
    if (!activeProjectId || !learnDraft || learnPromotionState === "saving") {
      return;
    }

    setLearnPromotionState("saving");
    try {
      await promoteRobotLearnDraftToProjectMemory({
        projectId: activeProjectId,
        learnDraft,
      });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId: activeProjectId } }));
      }
      setLearnPromotionState("saved");
      showStatus("Saved robot learning to project memory.", "success", 3000);
    } catch (error) {
      setLearnPromotionState("idle");
      const message = error instanceof Error ? error.message : String(error);
      showStatus(message || "Unable to save robot learning.", "error", 4500);
    }
  }

  function handleOpenLearnDraft() {
    if (!learnDraft) {
      return;
    }
    openWorkspaceFile(learnDraft.project_memory_candidate.suggested_block_path);
  }

  async function handleAttachProjectProvider() {
    if (!activeProjectId || projectProviderAttachBusy) {
      return;
    }
    if (!activeRobotProviderId) {
      showStatus("No discoverable embodied provider is currently available to attach.", "warning", 4000);
      return;
    }

    setProjectProviderAttachBusy(true);
    setProjectProviderAccessError(null);
    try {
      const result = await attachProjectProvider({
        projectId: activeProjectId,
        providerId: activeRobotProviderId,
        assistantHandle: providerAttachmentHandle,
        capabilityId: robotEmbodimentCapability.id,
        metadata: {
          attachedFrom: "robot_lab",
        },
      });
      if (!result.success) {
        throw new Error(result.error ?? "Unable to attach the embodied provider to project.");
      }

      const nextAccess = await resolveProjectProviderAccess({
        projectId: activeProjectId,
        providerId: activeRobotProviderId,
        assistantHandle: providerAttachmentHandle,
        capabilityId: robotEmbodimentCapability.id,
      });
      setProjectProviderAccess(nextAccess);
      showStatus(
        `Attached ${activeRobotProviderLabel} to ${activeProjectName ?? activeProjectId}.`,
        "success",
        3000,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProjectProviderAccessError(message);
      showStatus(message || "Unable to attach provider.", "error", 4500);
    } finally {
      setProjectProviderAttachBusy(false);
    }
  }

  async function runProbe(commandJson?: Record<string, unknown>, mode = "robot_lab_inference") {
    setBusy(true);
    setErrorText(null);
    try {
      const adjustedCommand = commandJson
        ? applyPreferencesToCommand(commandJson, preferences)
        : undefined;
      const response = await postProbe({
        backend,
        tcpTarget,
        readStatus,
        drainPending,
        sessionId: SESSION_ID,
        commandJson: adjustedCommand,
        skipCommand: !adjustedCommand,
      }, robotProviderClientOptions);

      const nextEvents = response.events || [];
      const statusEvent = [...nextEvents]
        .reverse()
        .find((event) => event.event === "status" && typeof event.value === "object");
      const learningEvents = buildProbeLearningSessionEvents({
        command: adjustedCommand,
        events: nextEvents,
        backend,
        sessionId: SESSION_ID,
        mode,
      });

      if (statusEvent && typeof statusEvent.value === "object" && statusEvent.value) {
        setStatusPayload(statusEvent.value as RobotLabEvent);
      }

      const inferredPose = inferHeadPose(nextEvents);
      if (inferredPose) {
        setHeadPose(inferredPose);
      }

      if (learningEvents.length > 0) {
        try {
          await persistSessionEvents(learningEvents, response.executionContext ?? null);
        } catch (persistError) {
          setErrorText(
            persistError instanceof Error
              ? persistError.message
              : String(persistError)
          );
        }
      }

      const latestAdaptationEvent =
        [...learningEvents].reverse().find((event) => event.kind === "adaptation_update") ?? null;
      setEvents((previous) => [...(latestAdaptationEvent ? [latestAdaptationEvent] : []), ...nextEvents, ...previous].slice(0, 16));
      setConnected(response.connected === true || adjustedCommand !== undefined);
      setStatusText(adjustedCommand ? "Command exchange complete" : "Connected to virtual robot");
      return true;
    } catch (error) {
      setConnected(false);
      setStatusText("Connection failed");
      setErrorText(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect() {
    await runProbe();
  }

  async function handlePreset(command: Record<string, unknown>) {
    setCustomCommand(JSON.stringify(command, null, 2));
    const adjusted = applyPreferencesToCommand(command, preferences);
    const previewPose = previewHeadPoseFromCommand(adjusted);
    if (previewPose) {
      setHeadPose(previewPose);
    }
    await runProbe(command);
  }

  async function handleCustomCommand() {
    const parsed = JSON.parse(customCommand) as Record<string, unknown>;
    const adjusted = applyPreferencesToCommand(parsed, preferences);
    const previewPose = previewHeadPoseFromCommand(adjusted);
    if (previewPose) {
      setHeadPose(previewPose);
    }
    await runProbe(parsed);
  }

  function applyAgentPromptSuggestion(nextPrompt: string) {
    setAgentPrompt(nextPrompt);
    setAgentErrorText(null);
  }

  async function executeEmbodiedBehaviorPrompt(promptOverride?: string) {
    const prompt = promptOverride ?? agentPrompt;
    const preResolution = resolveEmbodiedBehaviorPrompt(prompt, agentHandle, activeLearningSession);
    const sessionMode = preResolution.learningSession ? "robot_lab_learning_session" : "robot_lab_agent";
    setAgentErrorText(null);

    setAgentBusy(true);

    try {
      const learningSessionStartEvent = createLearningSessionStartedEvent({
        prompt,
        resolution: preResolution,
        sessionId: SESSION_ID,
        mode: sessionMode,
      });
      if (learningSessionStartEvent) {
        pushLocalEvent(learningSessionStartEvent);
        try {
          await persistSessionEvents([learningSessionStartEvent]);
        } catch (persistError) {
          setErrorText(
            persistError instanceof Error ? persistError.message : String(persistError)
          );
        }
      }
      const learningCorrectionEvent = createLearningCorrectionEvent({
        prompt,
        resolution: preResolution,
        sessionId: SESSION_ID,
        mode: sessionMode,
      });
      if (learningCorrectionEvent) {
        pushLocalEvent(learningCorrectionEvent);
        try {
          await persistSessionEvents([learningCorrectionEvent]);
        } catch (persistError) {
          setErrorText(
            persistError instanceof Error ? persistError.message : String(persistError)
          );
        }
      }
      const learningSessionEndedEvent = createLearningSessionEndedEvent({
        prompt,
        resolution: preResolution,
        sessionId: SESSION_ID,
        mode: sessionMode,
      });
      if (learningSessionEndedEvent) {
        pushLocalEvent(learningSessionEndedEvent);
        try {
          await persistSessionEvents([learningSessionEndedEvent]);
        } catch (persistError) {
          setErrorText(
            persistError instanceof Error ? persistError.message : String(persistError)
          );
        }
      }

      const executorRegistry = createLocalCapabilityExecutorRegistry({
        featureServices: [
          [
            ROBOT_EMBODIMENT_FEATURE_SERVICE_ID,
            {
              previewCommand: (command) => {
                setCustomCommand(JSON.stringify(command, null, 2));
                const adjusted = applyPreferencesToCommand(command, preferences);
                const previewPose = previewHeadPoseFromCommand(adjusted);
                if (previewPose) {
                  setHeadPose(previewPose);
                }
              },
              runCommand: (command) => runProbe(command, sessionMode),
              onStatus: setAgentStatusText,
              onCapabilityEvent: pushLocalEvent,
              refreshLearnDraft,
            } satisfies RobotEmbodimentExecutorContext,
          ],
        ],
      });

      const result = await executeCapabilityInvocation<RobotEmbodimentExecutionValue>(executorRegistry, {
        capabilityId: robotEmbodimentCapability.id,
        actionId: "perform_behavior",
        input: {
          prompt,
          selectedHandle: agentHandle,
          activeLearningSession,
        },
        source: "robot_lab",
      });

      if (!result.ok) {
        setAgentErrorText(result.error);
      } else if (result.value.learningSessionState === "ended") {
        setActiveLearningSession(null);
      } else if (result.value.learningSession) {
        setActiveLearningSession(
          preResolution.learningSessionSource === "explicit"
            ? createActiveRobotLearningSession(result.value.learningSession, agentHandle, prompt)
            : activeLearningSession ??
                createActiveRobotLearningSession(result.value.learningSession, agentHandle, prompt),
        );
      }
    } finally {
      setAgentBusy(false);
    }
  }

  function handlePreferenceField<K extends keyof UserPreferences>(key: K, value: number) {
    setPreferences((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function recordPreferenceUpdate() {
    const event = createLocalSessionEvent("preference_update", "app", "robot_lab_preferences", {
      user_preferences: {
        preferred_max_linear_velocity_mps: preferences.preferredMaxLinearVelocityMps,
        preferred_max_angular_velocity_dps: preferences.preferredMaxAngularVelocityDps,
        preferred_head_motion_scale: preferences.preferredHeadMotionScale,
      },
    });
    pushLocalEvent(event);
    try {
      await persistSessionEvents([event]);
      setStatusText("Persisted preference update");
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }

  async function recordUserFeedback(category: "drive_speed" | "drive_bias", feedback: "too_fast" | "veers_left") {
    const event = createLocalSessionEvent("user_feedback", "user", "robot_lab_feedback", {
      category,
      feedback,
      user_preferences: {
        preferred_max_linear_velocity_mps: preferences.preferredMaxLinearVelocityMps,
        preferred_max_angular_velocity_dps: preferences.preferredMaxAngularVelocityDps,
        preferred_head_motion_scale: preferences.preferredHeadMotionScale,
      },
    });
    pushLocalEvent(event);
    try {
      const response = await persistSessionEvents([event]);
      setStatusText(
        response.profileUpdate?.wrote
          ? "Applied user feedback to robot profile"
          : "Persisted user feedback"
      );
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }

  const statusBadgeTone = errorText ? "danger" : connected ? "success" : "warning";
  const agentBadgeTone = agentErrorText
    ? "danger"
    : resolvedEmbodiedAction.status === "ready" ||
        resolvedEmbodiedAction.status === "learning_ready" ||
        resolvedEmbodiedAction.status === "learning_correction" ||
        resolvedEmbodiedAction.status === "learning_complete"
      ? "success"
      : resolvedEmbodiedAction.status === "missing_capability"
        ? "warning"
        : "neutral";
  const replayBadgeTone = replayErrorText
    ? "danger"
    : replayReport?.has_recommended_adaptation_update
      ? "warning"
      : replayReport
        ? "success"
        : "neutral";
  const replayScoreDelta = replayReport
    ? roundToThousandths(replayReport.baseline.score - replayReport.best_variant.score)
    : 0;
  const replayDeltaItems = useMemo(
    () => (replayReport ? buildReplayDeltaItems(replayReport) : []),
    [replayReport]
  );
  const replayEvaluationRecommendation = replayEvaluation?.recommendation ?? null;
  const replayEvaluationPayload = replayEvaluationRecommendation?.payload;
  const replayEvaluationTone =
    replayEvaluationRecommendation?.decision === "import_recommended"
      ? "success"
      : replayEvaluationRecommendation?.decision === "hold_baseline"
        ? "warning"
        : "neutral";
  const replayEvaluationSummary = replayEvaluationRecommendation?.summary ?? replayEvaluation?.summary ?? null;
  const replayEvaluationReason = replayEvaluationRecommendation?.reason ?? null;
  const replayEvaluationComparisonSummary = replayEvaluation?.comparison?.summary ?? null;
  const replayEvidenceWindowText =
    typeof replayEvaluationPayload?.evidenceConfirmationCount === "number" &&
    typeof replayEvaluationPayload?.evidenceMinConfirmations === "number" &&
    typeof replayEvaluationPayload?.evidenceWindowSize === "number"
      ? `${replayEvaluationPayload.evidenceConfirmationCount}/${replayEvaluationPayload.evidenceMinConfirmations} confirmations across a ${replayEvaluationPayload.evidenceWindowSize}-run window`
      : null;
  const learnBadgeTone = learnErrorText ? "danger" : learnDraft ? "info" : "neutral";
  const projectProviderBadgeTone = !activeProjectId
    ? "neutral"
    : !activeRobotProviderId
      ? "warning"
    : projectProviderAccessError
      ? "danger"
      : projectProviderAccessBusy
        ? "neutral"
        : projectProviderAccess?.source === "project_policy_unavailable"
          ? "warning"
        : projectProviderAccess?.allowed && projectProviderAccess.source === "project_integration"
          ? "success"
          : "danger";
  const projectProviderStatusText = !activeProjectId
    ? "Select or create a project to attach an embodied provider intentionally."
    : !activeRobotProviderId
      ? activeRobotProviderError ??
        "No discoverable embodied provider is currently available from the local provider host."
    : projectProviderAccessBusy
      ? "Checking project provider access…"
      : projectProviderAccessError
        ? projectProviderAccessError
        : projectProviderAccess?.source === "project_policy_unavailable"
          ? projectProviderAccess.reason ??
            `Project provider policy for ${activeRobotProviderLabel} is unavailable right now. Reopen Project settings and retry.`
        : projectProviderAccess?.allowed && projectProviderAccess.source === "project_integration"
          ? `${activeRobotProviderLabel} is attached to this project for capability ${robotEmbodimentCapability.id}.`
          : projectProviderAccess?.reason ??
            `${activeRobotProviderLabel} is not currently allowed for this project.`;
  const canAttachProjectProvider =
    Boolean(activeProjectId) &&
    Boolean(activeRobotProviderId) &&
    !projectProviderAttachBusy &&
    !(projectProviderAccess?.allowed && projectProviderAccess.source === "project_integration") &&
    projectProviderAccess?.source !== "project_policy_unavailable";

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(255,235,216,0.9),transparent_38%),radial-gradient(circle_at_80%_18%,rgba(122,167,255,0.22),transparent_28%),linear-gradient(180deg,#f7f2ea_0%,#efe6d8_48%,#e8dccb_100%)] text-midnight">
      <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-8 sm:px-8 lg:px-10">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2">
            <Badge tone="info" size="sm" className="bg-white/70 backdrop-blur">
              Scratch Robot Lab
            </Badge>
            <Heading level={1} variant="hero" className="max-w-[12ch] text-4xl md:text-5xl">
              Connect Instafy to a virtual robot before hardware exists.
            </Heading>
            <Text variant="lead" tone="secondary" className="max-w-3xl">
              This page speaks to the local provider host, which attaches an embodied provider and
              then routes to either the virtual controller or the host BLE emulator. The mounted
              phone preview is the eventual on-robot expression surface.
            </Text>
          </div>
          <Link
            to="/"
            className="inline-flex rounded-full border border-white/60 bg-white/70 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm backdrop-blur hover:bg-white"
          >
            Back
          </Link>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            to="/knosh-runtime"
            className="inline-flex rounded-full border border-slate-900/10 bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800"
          >
            Open mounted runtime
          </Link>
          <div className="rounded-full border border-slate-900/10 bg-white/70 px-4 py-2 text-sm text-slate-700 shadow-sm">
            Use this after connection if you want the actual on-robot face + voice surface rather than the lab controls.
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          <Card
            padding="lg"
            className="overflow-hidden border-white/70 bg-white/72 shadow-modal backdrop-blur"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Text variant="overline" tone="muted">
                  Robot Transport
                </Text>
                <Heading level={2} variant="title" className="mt-1">
                  Connection Surface
                </Heading>
              </div>
              <Badge tone={statusBadgeTone} size="sm">
                {errorText ? "Host error" : connected ? "Connected" : "Waiting"}
              </Badge>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Text variant="caption" tone="muted">
                  Backend
                </Text>
                <Select
                  data-testid="robot-lab-backend-select"
                  value={backend}
                  onChange={(event) => {
                    const nextBackend = event.target.value as RobotBackend;
                    setBackend(nextBackend);
                    setTcpTarget(DEFAULT_TARGETS[nextBackend]);
                  }}
                >
                  <option value="virtual_tcp">Virtual TCP controller</option>
                  <option value="host_ble_emulator">Host BLE emulator</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Text variant="caption" tone="muted">
                  Target
                </Text>
                <Input
                  data-testid="robot-lab-target-input"
                  value={tcpTarget}
                  onChange={(event) => setTcpTarget(event.target.value)}
                />
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Toggle isSelected={readStatus} onChange={setReadStatus} label="Read status" />
              <Toggle isSelected={drainPending} onChange={setDrainPending} label="Drain pending events" />
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <Button variant="primary" size="md" onPress={handleConnect} isDisabled={busy}>
                {busy ? "Connecting…" : "Connect to virtual robot"}
              </Button>
              <Button variant="outline" size="md" onPress={() => runProbe()} isDisabled={busy}>
                Refresh link
              </Button>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-[0.85fr_1.15fr]">
              <Card tone="muted" padding="md" className="border-slate-200/70 bg-white/75">
                <Text variant="caption" tone="muted">
                  Provider host
                </Text>
                <Heading level={3} variant="subtitle" className="mt-2">
                  {statusText}
                </Heading>
                <Text variant="body" tone="secondary" className="mt-2 break-all">
                  {ROBOT_BRIDGE_BASE_URL}
                </Text>
                <Text variant="caption" tone="muted" className="mt-2 break-all">
                  Attached provider: {activeRobotProviderId ? `${activeRobotProviderLabel} (${activeRobotProviderId})` : "No discoverable embodied provider"}
                </Text>
                {sessionPath ? (
                  <Text variant="caption" tone="muted" className="mt-2 break-all">
                    {sessionPath}
                  </Text>
                ) : null}
                {errorText ? (
                  <Text variant="body" tone="danger" className="mt-3">
                    {errorText}
                  </Text>
                ) : null}
                {statusPayload ? (
                  <pre className="mt-3 overflow-x-auto rounded-2xl bg-[#101826] p-3 text-xs text-slate-100">
                    {JSON.stringify(statusPayload, null, 2)}
                  </pre>
                ) : (
                  <Text variant="body" tone="muted" className="mt-3">
                    Status reads appear here after the first successful probe.
                  </Text>
                )}
              </Card>

              <Card tone="muted" padding="md" className="border-slate-200/70 bg-white/75">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Text variant="caption" tone="muted">
                      Project attachment
                    </Text>
                    <Heading level={3} variant="subtitle" className="mt-2">
                      {activeProjectId ? activeProjectName ?? activeProjectId : "No active project"}
                    </Heading>
                  </div>
                  <Badge tone={projectProviderBadgeTone} size="sm">
                    {!activeProjectId
                      ? "No project"
                      : !activeRobotProviderId
                        ? "No provider"
                      : projectProviderAccess?.source === "project_policy_unavailable"
                        ? "Policy unavailable"
                      : projectProviderAccess?.allowed && projectProviderAccess.source === "project_integration"
                        ? "Attached"
                        : "Blocked"}
                  </Badge>
                </div>
                <Text variant="body" tone="secondary" className="mt-3">
                  {projectProviderStatusText}
                </Text>
                <Text variant="caption" tone="muted" className="mt-3">
                  Project settings are the source of truth for whether chat and Robot Lab may use this provider.
                </Text>
                <Text variant="caption" tone="muted" className="mt-3">
                  Embodied assistant
                </Text>
                <Text variant="body" tone="secondary" className="mt-1 break-all">
                  {providerAttachmentHandle}
                </Text>
                {projectProviderAccess?.integrationId ? (
                  <>
                    <Text variant="caption" tone="muted" className="mt-3">
                      Integration record
                    </Text>
                    <Text variant="body" tone="secondary" className="mt-1 break-all">
                      {projectProviderAccess.integrationId}
                    </Text>
                  </>
                ) : null}
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    size="md"
                    onPress={() => {
                      void handleAttachProjectProvider();
                    }}
                    isDisabled={!canAttachProjectProvider}
                  >
                    {projectProviderAttachBusy
                      ? "Attaching…"
                      : projectProviderAccess?.allowed && projectProviderAccess.source === "project_integration"
                        ? "Attached to project"
                        : !activeRobotProviderId
                          ? "No embodied provider"
                        : projectProviderAccess?.source === "project_policy_unavailable"
                          ? "Check project policy"
                        : `Attach ${activeRobotProviderLabel} to project`}
                  </Button>
                </div>
              </Card>

              <Card tone="muted" padding="md" className="border-slate-200/70 bg-white/75">
                <Text variant="caption" tone="muted">
                  Agent capability surface
                </Text>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <Heading level={3} variant="subtitle">
                    {activeAgentSummary}
                  </Heading>
                  <Badge tone={agentBadgeTone} size="sm">
                    {agentErrorText
                      ? "Needs attention"
                      : resolvedEmbodiedAction.status === "ready"
                        ? "Embodied"
                        : resolvedEmbodiedAction.status === "learning_ready"
                          ? "Learning mode"
                          : resolvedEmbodiedAction.status === "learning_correction"
                            ? "Coaching note"
                            : resolvedEmbodiedAction.status === "learning_complete"
                              ? "Learning wrapped"
                        : resolvedEmbodiedAction.status === "missing_capability"
                          ? "No robot capability"
                          : "Awaiting intent"}
                  </Badge>
                </div>
                <Text variant="body" tone="secondary" className="mt-2">
                  This is the clean split for the future Instafy integration: agent identity and
                  capability selection stay high-level here, then the mapped behavior flows down to
                  the same robot transport contract.
                </Text>

                <div className="mt-4">
                  <SegmentedControl
                    label="Active agent"
                    value={agentHandle}
                    onChange={(value) => {
                      const nextHandle = value as EmbodiedAgentHandle;
                      setAgentHandle(nextHandle);
                      setAgentPrompt(
                        getEmbodiedAgentProfile(nextHandle)?.defaultPrompt ?? agentPrompt,
                      );
                      setAgentErrorText(null);
                    }}
                    options={embodiedAgentProfiles.map((profile) => ({
                      value: profile.handle,
                      label: profile.displayName,
                    }))}
                  />
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {embodiedAgentProfiles.map((profile) => {
                    const handle = profile.handle;
                    const isActive = handle === agentHandle;
                    return (
                      <Card
                        key={handle}
                        tone="muted"
                        padding="sm"
                        className={[
                          "border transition-colors",
                          isActive ? "border-slate-900/15 bg-[#f7f2ea]" : "border-slate-200/70 bg-white/90",
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <Heading level={4} variant="bodyStrong">
                            {profile.displayName}
                          </Heading>
                          <Badge tone={profile.capabilityEnabled ? "success" : "neutral"} size="sm">
                            {profile.capabilityEnabled ? robotEmbodimentCapability.id : "no embodiment"}
                          </Badge>
                        </div>
                        <Text variant="caption" tone="secondary" className="mt-2">
                          {profile.summary}
                        </Text>
                        {profile.capabilities.length > 0 ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {profile.capabilities.map((capability) => (
                              <Badge key={capability} tone="info" size="sm">
                                {capability}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <Text variant="caption" tone="muted" className="mt-3">
                            This agent stays conversational only until a hardware capability is explicitly granted.
                          </Text>
                        )}
                      </Card>
                    );
                  })}
                </div>

                <Text variant="caption" tone="muted" className="mt-4">
                  Capability prompt briefing
                </Text>
                <Textarea
                  rows={10}
                  className="mt-2 font-mono text-xxs"
                  value={selectedAgentPromptContext}
                  readOnly
                />

                <Text variant="caption" tone="muted" className="mt-4">
                  Agent prompt
                </Text>
                <Textarea
                  rows={3}
                  className="mt-2"
                  value={agentPrompt}
                  onChange={(event) => setAgentPrompt(event.target.value)}
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedEmbodiedAgent?.capabilityEnabled ? (
                    resolvedEmbodiedAction.behavior?.promptExamples.map((example) => (
                      <Button
                        key={example}
                        variant="outline"
                        onPress={() => applyAgentPromptSuggestion(example)}
                        isDisabled={agentBusy || busy}
                      >
                        {example.replace(
                          new RegExp(`^${selectedEmbodiedAgentMentionToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i"),
                          "",
                        )}
                      </Button>
                    ))
                  ) : (
                    <Button
                      variant="outline"
                      onPress={() =>
                        applyAgentPromptSuggestion(
                          `${selectedEmbodiedAgentMentionToken} summarize the latest robot session`,
                        )
                      }
                      isDisabled={agentBusy || busy}
                    >
                      Non-robot example
                    </Button>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-3">
                  <Button
                    variant="primary"
                    onPress={() => {
                      void executeEmbodiedBehaviorPrompt();
                    }}
                    isDisabled={busy || agentBusy}
                  >
                    {agentBusy ? "Running intent…" : "Run agent intent"}
                  </Button>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-[0.95fr_1.05fr]">
                  <Card tone="muted" padding="sm" className="bg-[#f7f2ea]">
                    <Text variant="caption" tone="muted">
                      Intent resolution
                    </Text>
                    <Heading level={4} variant="bodyStrong" className="mt-2">
                      {resolvedEmbodiedAction.behavior?.title ||
                        resolvedEmbodiedAction.learningSession?.goal ||
                        selectedEmbodiedAgent?.displayName}
                    </Heading>
                    <Text variant="caption" tone="secondary" className="mt-2">
                      {resolvedEmbodiedAction.detail}
                    </Text>
                    {resolvedEmbodiedAction.learningSession ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Badge tone="info" size="sm">
                          {resolvedEmbodiedAction.learningSession.mode}
                        </Badge>
                        <Badge tone="info" size="sm">
                          diagnostics {resolvedEmbodiedAction.learningSession.diagnosticsLevel}
                        </Badge>
                        <Badge tone="info" size="sm">
                          {resolvedEmbodiedAction.learningSession.consolidation}
                        </Badge>
                        {activeLearningSession ? (
                          <Badge tone="warning" size="sm">
                            session active: {activeLearningSession.goal}
                          </Badge>
                        ) : null}
                      </div>
                    ) : null}
                    <Text variant="caption" tone="muted" className="mt-3">
                      {agentStatusText}
                    </Text>
                    {agentErrorText ? (
                      <Text variant="body" tone="danger" className="mt-2">
                        {agentErrorText}
                      </Text>
                    ) : null}
                  </Card>
                  <Card tone="muted" padding="sm" className="bg-[#f7f2ea]">
                    <Text variant="caption" tone="muted">
                      Planned transport steps
                    </Text>
                    {resolvedEmbodiedAction.behavior ? (
                      <div className="mt-3 space-y-3">
                        {resolvedEmbodiedAction.behavior.steps.map((step, index) => (
                          <div key={`${resolvedEmbodiedAction.behavior?.id}-${index}`}>
                            <div className="flex items-center justify-between gap-3">
                              <Heading level={4} variant="bodyStrong">
                                {index + 1}. {step.label}
                              </Heading>
                              <Badge tone="info" size="sm">
                                {describeBehaviorCommand(step)}
                              </Badge>
                            </div>
                            {step.delayMs ? (
                              <Text variant="caption" tone="muted" className="mt-1">
                                Hold {step.delayMs} ms before the next step.
                              </Text>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : resolvedEmbodiedAction.learningSession ? (
                      <div className="mt-3 space-y-3">
                        <Text variant="body" tone="secondary">
                          {resolvedEmbodiedAction.status === "learning_correction"
                            ? "This prompt was captured as a coaching note inside the active learning session. No robot transport command is required for that note."
                            : resolvedEmbodiedAction.status === "learning_complete"
                              ? "This prompt closes the active coached learning session and consolidates the latest learn draft."
                              : "This prompt opened a coached learning session. Use natural-language attempts and corrections, and the session artifacts plus learn draft will refresh automatically."}
                        </Text>
                        <div className="flex flex-wrap gap-2">
                          <Badge tone="info" size="sm">
                            Goal: {resolvedEmbodiedAction.learningSession.goal}
                          </Badge>
                          <Badge tone="info" size="sm">
                            Diagnostics: {resolvedEmbodiedAction.learningSession.diagnosticsLevel}
                          </Badge>
                          {resolvedEmbodiedAction.coachingNote ? (
                            <Badge tone="warning" size="sm">
                              note: {resolvedEmbodiedAction.coachingNote}
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <Text variant="body" tone="muted" className="mt-3">
                        Resolve a robot-capable prompt to preview its low-level transport plan.
                      </Text>
                    )}
                  </Card>
                </div>
              </Card>
            </div>

            <RobotCommandDebuggerSection
              busy={busy}
              agentBusy={agentBusy}
              customCommand={customCommand}
              onCustomCommandChange={setCustomCommand}
              onLookLeft={() => handlePreset(DEFAULT_COMMANDS.lookLeft)}
              onCenter={() => handlePreset(DEFAULT_COMMANDS.center)}
              onLookRight={() => handlePreset(DEFAULT_COMMANDS.lookRight)}
              onDriveArc={() => handlePreset(DEFAULT_COMMANDS.driveArc)}
              onStop={() => handlePreset(DEFAULT_COMMANDS.stop)}
              onSendCustomCommand={handleCustomCommand}
              preferences={preferences}
              onPreferredMaxLinearVelocityChange={(value) =>
                handlePreferenceField(
                  "preferredMaxLinearVelocityMps",
                  toFiniteNumber(value, 0.25)
                )
              }
              onPreferredMaxAngularVelocityChange={(value) =>
                handlePreferenceField(
                  "preferredMaxAngularVelocityDps",
                  toFiniteNumber(value, 90)
                )
              }
              onPreferredHeadMotionScaleChange={(value) =>
                handlePreferenceField("preferredHeadMotionScale", toFiniteNumber(value, 1))
              }
              onRecordPreferenceUpdate={() => {
                void recordPreferenceUpdate();
              }}
              onResetPreferences={() => setPreferences(DEFAULT_PREFERENCES)}
              onRobotTooFast={() => {
                void recordUserFeedback("drive_speed", "too_fast");
              }}
              onRobotVeeredLeft={() => {
                void recordUserFeedback("drive_bias", "veers_left");
              }}
            />
          </Card>

          <div className="grid gap-6">
            <RobotMountedPreviewSection
              mountMode={mountMode}
              orientation={orientation}
              onMountModeChange={setMountMode}
              onOrientationChange={setOrientation}
              stageTransform={stageTransform}
              headPose={headPose}
            />

            <RobotReplayAnalysisSection
              replayBadgeTone={replayBadgeTone}
              replayBusy={replayBusy}
              replayErrorText={replayErrorText}
              replayStatusText={replayStatusText}
              replayReportPath={replayReportPath}
              replayReport={replayReport}
              replaySamples={replaySamples}
              replaySeed={replaySeed}
              replayApplyLastFrame={replayApplyLastFrame}
              onReplaySamplesChange={(value) =>
                setReplaySamples(Math.max(1, Math.round(toFiniteNumber(value, 12))))
              }
              onReplaySeedChange={(value) =>
                setReplaySeed(Math.round(toFiniteNumber(value, 42)))
              }
              onReplayApplyLastFrameChange={setReplayApplyLastFrame}
              onRunReplayAnalysis={() => {
                void runReplayAnalysis();
              }}
              onRefreshReplayReport={() => {
                void refreshReplayReport();
              }}
              onApplyReplayRecommendation={() => {
                void applyReplayRecommendation();
              }}
              replayScoreDelta={replayScoreDelta}
              replayEvaluationTone={replayEvaluationTone}
              replayEvaluationDecision={replayEvaluationRecommendation?.decision ?? null}
              replayEvaluationSummary={replayEvaluationSummary}
              replayEvaluationReason={replayEvaluationReason}
              replayEvaluationComparisonSummary={replayEvaluationComparisonSummary}
              replayEvaluationPath={replayEvaluationPath}
              replayEvaluationErrorText={replayEvaluationErrorText}
              replayEvidenceWindowText={replayEvidenceWindowText}
              replayDeltaItems={replayDeltaItems}
              replayApplySummary={replayApplySummary}
            />

            <RobotLearnDraftSection
              learnBadgeTone={learnBadgeTone}
              learnErrorText={learnErrorText}
              learnDraft={learnDraft}
              learnBusy={learnBusy}
              learnStatusText={learnStatusText}
              learnPromotionState={learnPromotionState}
              activeProjectId={activeProjectId}
              activeProjectName={activeProjectName}
              onRefreshLearnDraft={() => {
                void refreshLearnDraft();
              }}
              onPromoteLearnDraft={() => {
                void handlePromoteLearnDraft();
              }}
              onOpenLearnDraft={handleOpenLearnDraft}
            />

            <RobotEventTapeSection events={events} />
          </div>
        </div>
      </main>
    </div>
  );
}
