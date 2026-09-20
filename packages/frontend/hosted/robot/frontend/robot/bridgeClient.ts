import type {
  ProviderArtifactReference,
  ProviderEvaluationReport,
  ProviderExecutionContext,
  ProviderRecommendation,
} from "@instafy/provider-contract";
import type { ProviderInitializationContext } from "@instafy/provider-client";
import {
  callLocalProviderTool,
  getLocalProviderForCapability,
  getLocalProviderSummary,
  LOCAL_PROVIDER_HOST_BASE_URL,
  postLocalProviderTransportProbe,
  readLocalProviderResource,
  type LocalProviderSummary,
} from "@instafy/frontend/feature-api";
import { ROBOT_EMBODIMENT_CAPABILITY_ID } from "./robotCapabilityMetadata";

export type RobotBackend = "virtual_tcp" | "host_ble_emulator";

export type RobotBridgeEvent = Record<string, unknown>;

async function loadControllerClient() {
  return (
    await import(
      "@instafy/frontend/feature-api/controller"
    )
  ).controllerClient;
}

function providerInitializationFromBody(
  body: Record<string, unknown>,
): ProviderInitializationContext | undefined {
  const value = body.projectBinding;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("projectBinding must be an object");
  }
  return value as ProviderInitializationContext;
}

export type PersistedRobotProfile = {
  user_preferences?: {
    preferred_max_linear_velocity_mps?: number;
    preferred_max_angular_velocity_dps?: number;
    preferred_head_motion_scale?: number;
  };
};

export type ProbeResponse = {
  ok: boolean;
  connected?: boolean;
  events?: RobotBridgeEvent[];
  executionContext?: ProviderExecutionContext;
  error?: string;
  stderr?: string;
};

export type ProfileBridgeResponse = {
  ok: boolean;
  value?: PersistedRobotProfile;
  error?: string;
};

export type ProfileUpdateSummary = {
  profile?: PersistedRobotProfile;
  wrote?: boolean;
  revision_before?: number;
  revision_after?: number;
  counters?: Record<string, unknown>;
  profile_path?: string;
  session_path?: string;
};

export type SessionEventsResponse = {
  ok: boolean;
  sessionPath?: string;
  appendedCount?: number;
  profileUpdate?: ProfileUpdateSummary | null;
  executionContext?: ProviderExecutionContext;
  error?: string;
};

export type ReplayHarnessVariant = {
  variant_id: string;
  score: number;
  learned_adaptation?: RobotBridgeEvent;
};

export type ReplayHarnessRecommendation = {
  blend_alpha: number;
  learned_adaptation?: RobotBridgeEvent;
};

export type ReplayHarnessReport = {
  generated_at_iso8601: string;
  session_path: string;
  randomized_sample_count: number;
  baseline: ReplayHarnessVariant;
  best_variant: ReplayHarnessVariant;
  has_recommended_adaptation_update: boolean;
  recommended_adaptation_update?: ReplayHarnessRecommendation | null;
  final_pose?: RobotBridgeEvent;
};

export type ReplayEvaluationRecommendationPayload = {
  baselineScore?: number;
  bestScore?: number;
  bestVariantId?: string;
  scoreImprovement?: number;
  recommendationThreshold?: number;
  meetsRecommendationThreshold?: boolean;
  repeatConfirmationRequired?: boolean;
  repeatedImprovementConfirmed?: boolean;
  evidenceWindowSize?: number;
  evidenceConfirmationCount?: number;
  evidenceMinConfirmations?: number;
  similarReplayCount?: number;
};

export type ReplayEvaluationMetrics = {
  baselineScore?: number;
  bestScore?: number;
  randomizedSampleCount?: number;
  telemetryFrameCount?: number;
  moduleSignalCount?: number;
  runtimeBackendIds?: string[];
  observationCueCategories?: string[];
};

export type ReplayEvaluationReport = Omit<ProviderEvaluationReport<ReplayEvaluationMetrics>, "recommendation"> & {
  recommendation?: ProviderRecommendation<ReplayEvaluationRecommendationPayload>;
};

export type RobotRuntimeStatusValue = {
  provider_id?: string;
  preferred_runtime_backend_id?: string | null;
  configured_runtime_backend_id?: string | null;
  configured_runtime_backend?: Record<string, unknown> | null;
  transport?: {
    configured?: boolean;
    adapter_transport_backend?: string | null;
    tcp_target?: string | null;
    session_id?: string | null;
    source?: string | null;
    timeout_ms?: number | null;
  } | null;
  status_probe?: {
    attempted?: boolean;
    supported?: boolean;
    value?: Record<string, unknown> | null;
    error?: string | Record<string, unknown> | null;
  } | null;
  expected_status_summary?: Record<string, unknown> | null;
};

export type RobotRuntimeStatusResponse = {
  ok: boolean;
  value?: RobotRuntimeStatusValue | null;
  error?: string;
};

export type RobotPowerStatusValue = {
  available?: boolean;
  source?: string | null;
  path?: string | null;
  session_id?: string | null;
  robot_id?: string | null;
  mode?: string | null;
  telemetry_timestamp_ns?: number | null;
  battery_voltage_v?: number | null;
  fault_flags?: string[] | null;
  watchdog_state?: string | null;
  status_summary?: Record<string, unknown> | null;
  reason?: string | null;
};

export type RobotPowerStatusResponse = {
  ok: boolean;
  value?: RobotPowerStatusValue | null;
  error?: string;
};

export type ReplayReportResponse = {
  ok: boolean;
  exists?: boolean;
  reportPath?: string;
  report?: ReplayHarnessReport | null;
  executionContext?: ProviderExecutionContext;
  error?: string;
  stderr?: string;
};

export type ReplayEvaluationResponse = {
  ok: boolean;
  exists?: boolean;
  evaluationPath?: string;
  evaluation?: ReplayEvaluationReport | null;
  error?: string;
};

export type ReplayApplySummary = {
  report_path: string;
  session_path: string;
  profile_path: string;
  had_recommendation: boolean;
  dry_run: boolean;
  appended_to_session: boolean;
  skipped_existing_event: boolean;
  session_event_id?: string | null;
  profile_update?: ProfileUpdateSummary | null;
  generated_event?: RobotBridgeEvent | null;
};

export type ReplayApplyResponse = {
  ok: boolean;
  summary?: ReplayApplySummary;
  reportPath?: string;
  report?: ReplayHarnessReport | null;
  executionContext?: ProviderExecutionContext;
  error?: string;
};

export type LearnDraftCandidate = {
  block_id: string;
  title: string;
  suggested_block_path: string;
  tags: string[];
  markdown: string;
};

export type LearnDraftSessionSummary = {
  telemetry_count: number;
  command_telemetry_count: number;
  preference_update_count: number;
  user_feedback_count: number;
  adaptation_update_count: number;
  user_feedback_signals: string[];
  adaptation_modes: string[];
};

export type LearnDraftPayload = {
  session_path: string;
  profile_path: string;
  report_path?: string | null;
  robot_id: string;
  project_memory_candidate: LearnDraftCandidate;
  session_summary: LearnDraftSessionSummary;
  replay_summary?: {
    baseline_score: number;
    best_score: number;
    best_variant_id: string;
    randomized_sample_count: number;
    has_recommended_adaptation_update: boolean;
  };
};

export type LearnDraftResponse = {
  ok: boolean;
  value?: LearnDraftPayload;
  executionContext?: ProviderExecutionContext;
  error?: string;
};

type SessionEventsToolValue = {
  session_id: string;
  session_path: string;
  appended_count: number;
  profile_update?: ProfileUpdateSummary | null;
};

type RobotSessionRuntimeContext = {
  backend_id?: string;
  transport_kind?: string;
  transport_target?: string;
  execution_surface?: string;
};

export const ROBOT_BRIDGE_BASE_URL = LOCAL_PROVIDER_HOST_BASE_URL;

const DEFAULT_ROBOT_TOOL_ALIASES = {
  appendSessionEvents: "knosh.robot.session.events.append",
  buildLearnDraft: "knosh.robot.learning.draft.build",
  runReplayHarness: "knosh.robot.replay.run_harness",
  importReplayReport: "knosh.robot.replay.import_report",
};

const DEFAULT_ROBOT_RESOURCE_ALIASES = {
  defaultRobotProfile: "knosh://robot/profile/default",
  latestReplayReport: "knosh://robot/replay/latest-report",
  latestReplayEvaluation: "knosh://robot/replay/latest-evaluation",
  runtimeStatus: "knosh://robot/runtime-status",
  runtimeBackends: "knosh://robot/runtime-backends",
  powerStatus: "knosh://robot/power-status",
};

type RobotProviderClientOptions = {
  providerId?: string | null;
  provider?: LocalProviderSummary | null;
  projectId?: string | null;
  projectBinding?: ProviderInitializationContext | null;
};

function resourceReadOptions(
  options?: RobotProviderClientOptions,
) {
  return options?.projectBinding
    ? { initialization: options.projectBinding }
    : undefined;
}

function createMissingRobotProviderError() {
  return new Error("No discoverable embodied provider is available for robot actions.");
}

function resolveRobotProviderId(options?: RobotProviderClientOptions) {
  return options?.providerId?.trim() || options?.provider?.id?.trim() || "";
}

function normalizeRobotSessionRuntimeContext(
  runtime: ProviderExecutionContext["runtime"] | null | undefined,
): RobotSessionRuntimeContext | undefined {
  if (!runtime) {
    return undefined;
  }
  const nextRuntime: RobotSessionRuntimeContext = {
    backend_id: runtime.backendId?.trim() || undefined,
    transport_kind: runtime.transportKind?.trim() || undefined,
    transport_target: runtime.transportTarget?.trim() || undefined,
    execution_surface: runtime.executionSurface?.trim() || undefined,
  };
  return Object.values(nextRuntime).some(Boolean) ? nextRuntime : undefined;
}

function normalizeRobotSessionArtifactRefs(
  artifactRefs: ProviderArtifactReference[] | null | undefined,
) {
  if (!artifactRefs?.length) {
    return undefined;
  }

  const normalized = artifactRefs
    .map((artifactRef) => {
      const kind = artifactRef.kind?.trim();
      if (!kind) {
        return null;
      }
      return {
        kind,
        role: artifactRef.role?.trim() || undefined,
        uri: artifactRef.uri?.trim() || undefined,
        title: artifactRef.title?.trim() || undefined,
        mime_type: artifactRef.mimeType?.trim() || undefined,
        metadata:
          artifactRef.metadata && typeof artifactRef.metadata === "object"
            ? artifactRef.metadata
            : undefined,
      };
    })
    .filter((artifactRef): artifactRef is NonNullable<typeof artifactRef> => artifactRef !== null);

  return normalized.length > 0 ? normalized : undefined;
}

function applyExecutionMetadataToSessionEvents(
  events: unknown,
  executionContext: ProviderExecutionContext | null | undefined,
) {
  if (!Array.isArray(events) || events.length === 0) {
    return events;
  }
  const normalizedArtifactRefs = normalizeRobotSessionArtifactRefs(executionContext?.artifactRefs);
  if (!normalizedArtifactRefs) {
    return events;
  }

  return events.map((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return event;
    }
    const record = event as Record<string, unknown>;
    if (Array.isArray(record.artifact_refs) && record.artifact_refs.length > 0) {
      return event;
    }
    return {
      ...record,
      artifact_refs: normalizedArtifactRefs,
    };
  });
}

async function resolveNativeCapabilityRuntimeForOptions(options?: RobotProviderClientOptions) {
  const { resolveNativeCapabilityRuntimeRegistration } = await import(
    "@instafy/frontend/feature-api/runtime"
  );
  return resolveNativeCapabilityRuntimeRegistration({
    providerId: resolveRobotProviderId(options),
    provider: options?.provider,
  });
}

async function resolveNativeCapabilityRuntimeSelection(options?: RobotProviderClientOptions) {
  const runtimeRegistration = await resolveNativeCapabilityRuntimeForOptions(options);
  const projectId = options?.projectId?.trim();
  if (!projectId || !runtimeRegistration) {
    return null;
  }

  const controllerClient = await loadControllerClient();
  const integrationsResult = await controllerClient.integrations.listForProject(projectId).catch(
    () => null,
  );
  if (!integrationsResult?.success) {
    return null;
  }
  const {
    getProjectIntegrationByProvider,
    getProjectProviderSelectedDevice,
  } = await import(
    "@instafy/frontend/feature-api/runtime"
  );

  const providerId = resolveRobotProviderId(options) || runtimeRegistration.familyId;
  const integration = getProjectIntegrationByProvider(integrationsResult.integrations, providerId);
  if (!integration) {
    return null;
  }
  const selectedDevice = getProjectProviderSelectedDevice(integration);
  const selection = await runtimeRegistration.resolveSelection({
    providerId,
    selectedDevice,
  });
  if (!selection) {
    return null;
  }

  return {
    runtimeRegistration,
    providerId,
    selection,
  };
}

async function resolveRobotProviderContext(options?: RobotProviderClientOptions) {
  const explicitProviderId = resolveRobotProviderId(options);
  const provider = explicitProviderId.length > 0
    ? options?.provider && options.provider.id === explicitProviderId
      ? options.provider
      : (await getLocalProviderSummary(explicitProviderId).catch(() => null)) ?? options?.provider ?? null
    : (await getLocalProviderForCapability(ROBOT_EMBODIMENT_CAPABILITY_ID).catch(() => null)) ??
      options?.provider ??
      null;
  const providerId = explicitProviderId || provider?.id?.trim() || "";

  if (!providerId) {
    throw createMissingRobotProviderError();
  }

  return {
    providerId,
    provider,
    toolAliases: {
      ...DEFAULT_ROBOT_TOOL_ALIASES,
      ...(provider?.toolAliases ?? {}),
    },
    resourceAliases: {
      ...DEFAULT_ROBOT_RESOURCE_ALIASES,
      ...(provider?.resourceAliases ?? {}),
    },
  };
}

export async function postProbe(
  body: Record<string, unknown>,
  options?: RobotProviderClientOptions,
): Promise<ProbeResponse> {
  const nativeRuntime = await resolveNativeCapabilityRuntimeSelection(options);
  if (nativeRuntime) {
    const nativeResponse = await nativeRuntime.runtimeRegistration.postProbe(body, {
      providerId: nativeRuntime.providerId,
      ...nativeRuntime.selection,
    });
    return {
      ok: true,
      connected: nativeResponse.connected,
      events: nativeResponse.events,
      executionContext: nativeResponse.executionContext,
    } satisfies ProbeResponse;
  }
  const context = await resolveRobotProviderContext(options);
  const response = await postLocalProviderTransportProbe<ProbeResponse>(context.providerId, body);
  const envelopeValue =
    response.value && typeof response.value === "object"
      ? (response.value as ProbeResponse)
      : ((response as unknown as ProbeResponse) ?? null);
  return {
    ok: response.ok,
    connected: envelopeValue?.connected,
    events: envelopeValue?.events,
    executionContext: response.executionContext ?? envelopeValue?.executionContext,
    error: response.error ?? envelopeValue?.error,
    stderr: response.stderr ?? envelopeValue?.stderr,
  } satisfies ProbeResponse;
}

export async function fetchRobotProfile(
  options?: RobotProviderClientOptions,
): Promise<ProfileBridgeResponse> {
  const context = await resolveRobotProviderContext(options);
  const response = await readLocalProviderResource<PersistedRobotProfile>(
    context.providerId,
    context.resourceAliases.defaultRobotProfile,
    resourceReadOptions(options),
  );
  return {
    ok: true,
    value: response.value ?? undefined,
  } satisfies ProfileBridgeResponse;
}

export async function fetchRobotRuntimeStatus(
  options?: RobotProviderClientOptions,
): Promise<RobotRuntimeStatusResponse> {
  const context = await resolveRobotProviderContext(options);
  const response = await readLocalProviderResource<RobotRuntimeStatusValue>(
    context.providerId,
    context.resourceAliases.runtimeStatus,
    resourceReadOptions(options),
  );
  return {
    ok: true,
    value: response.value ?? null,
  } satisfies RobotRuntimeStatusResponse;
}

export async function fetchRobotPowerStatus(
  options?: RobotProviderClientOptions,
): Promise<RobotPowerStatusResponse> {
  const context = await resolveRobotProviderContext(options);
  const response = await readLocalProviderResource<RobotPowerStatusValue>(
    context.providerId,
    context.resourceAliases.powerStatus ?? DEFAULT_ROBOT_RESOURCE_ALIASES.powerStatus,
    resourceReadOptions(options),
  );
  return {
    ok: true,
    value: response.value ?? null,
  } satisfies RobotPowerStatusResponse;
}

export async function postSessionEvents(
  body: Record<string, unknown>,
  options?: RobotProviderClientOptions,
): Promise<SessionEventsResponse> {
  const context = await resolveRobotProviderContext(options);
  const initialization = providerInitializationFromBody(body);
  const executionContext =
    body.executionContext && typeof body.executionContext === "object" && !Array.isArray(body.executionContext)
      ? (body.executionContext as ProviderExecutionContext)
      : undefined;
  const response = await callLocalProviderTool<SessionEventsToolValue>(
    context.providerId,
    context.toolAliases.appendSessionEvents,
    {
      session_id: body.sessionId,
      session_path: body.sessionPath,
      events: applyExecutionMetadataToSessionEvents(body.events, executionContext),
      runtime: normalizeRobotSessionRuntimeContext(executionContext?.runtime),
      apply_profile_update: body.applyProfileUpdate,
      profile_path: body.profilePath,
    },
    initialization ? { initialization } : undefined,
  );
  return {
    ok: true,
    sessionPath: response.value?.session_path,
    appendedCount: response.value?.appended_count,
    profileUpdate: response.value?.profile_update ?? null,
    executionContext: response.executionContext,
  } satisfies SessionEventsResponse;
}

export async function fetchReplayReport(
  options?: RobotProviderClientOptions,
): Promise<ReplayReportResponse> {
  const context = await resolveRobotProviderContext(options);
  const response = await readLocalProviderResource<ReplayHarnessReport>(
    context.providerId,
    context.resourceAliases.latestReplayReport,
    resourceReadOptions(options),
  );
  return {
    ok: true,
    exists: response.exists ?? Boolean(response.value),
    reportPath: response.sourcePath,
    report: response.value ?? null,
  } satisfies ReplayReportResponse;
}

export async function fetchReplayEvaluation(
  options?: RobotProviderClientOptions,
): Promise<ReplayEvaluationResponse> {
  const context = await resolveRobotProviderContext(options);
  const response = await readLocalProviderResource<ReplayEvaluationReport>(
    context.providerId,
    context.resourceAliases.latestReplayEvaluation,
    resourceReadOptions(options),
  );
  return {
    ok: true,
    exists: response.exists ?? Boolean(response.value),
    evaluationPath: response.sourcePath,
    evaluation: response.value ?? null,
  } satisfies ReplayEvaluationResponse;
}

export async function postReplayRun(
  body: Record<string, unknown>,
  options?: RobotProviderClientOptions,
): Promise<ReplayReportResponse> {
  const context = await resolveRobotProviderContext(options);
  const initialization = providerInitializationFromBody(body);
  const response = await callLocalProviderTool<{
    report_path: string;
    report?: ReplayHarnessReport | null;
    stdout?: string;
    stderr?: string;
  }>(
    context.providerId,
    context.toolAliases.runReplayHarness,
    {
      session_path: body.sessionPath,
      report_path: body.reportPath,
      profile_path: body.profilePath,
      samples: body.samples,
      seed: body.seed,
      apply_last_frame: body.applyLastFrame,
    },
    initialization ? { initialization } : undefined,
  );
  return {
    ok: true,
    exists: Boolean(response.value?.report),
    reportPath: response.value?.report_path,
    report: response.value?.report ?? null,
    executionContext: response.executionContext,
    stderr: response.value?.stderr,
  } satisfies ReplayReportResponse;
}

export async function postReplayApply(
  body: Record<string, unknown>,
  options?: RobotProviderClientOptions,
): Promise<ReplayApplyResponse> {
  const context = await resolveRobotProviderContext(options);
  const initialization = providerInitializationFromBody(body);
  const summaryResponse = await callLocalProviderTool<ReplayApplySummary>(
    context.providerId,
    context.toolAliases.importReplayReport,
    {
      report_path: body.reportPath,
      session_path: body.sessionPath,
      profile_path: body.profilePath,
      dry_run: body.dryRun,
    },
    initialization ? { initialization } : undefined,
  );
  const reportResponse = await readLocalProviderResource<ReplayHarnessReport>(
    context.providerId,
    context.resourceAliases.latestReplayReport,
    initialization ? { initialization } : resourceReadOptions(options),
  ).catch(() => null);

  return {
    ok: true,
    summary: summaryResponse.value,
    reportPath:
      summaryResponse.value?.report_path ??
      reportResponse?.sourcePath,
    report: reportResponse?.value ?? null,
    executionContext: summaryResponse.executionContext,
  } satisfies ReplayApplyResponse;
}

export async function postLearnDraft(
  body: Record<string, unknown>,
  options?: RobotProviderClientOptions,
): Promise<LearnDraftResponse> {
  const context = await resolveRobotProviderContext(options);
  const response = await callLocalProviderTool<LearnDraftPayload>(
    context.providerId,
    context.toolAliases.buildLearnDraft,
    {
      session_path: body.sessionPath,
      profile_path: body.profilePath,
      report_path: body.reportPath,
    },
  );
  return {
    ok: true,
    value: response.value,
    executionContext: response.executionContext,
  } satisfies LearnDraftResponse;
}
