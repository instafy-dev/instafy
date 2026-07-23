import type { ProviderHostSurfaceId, ProviderUiSurfaceMetadata } from "./provider-ui-surface.js";

export type ProviderCapabilityId = string;

export type ProviderToolAliases = {
  appendSessionEvents?: string;
  buildLearnDraft?: string;
  runReplayHarness?: string;
  importReplayReport?: string;
  bootstrapHostDependencies?: string;
  capturePhoto?: string;
  capturePhotoSeries?: string;
  transcribeAudio?: string;
  synthesizeSpeech?: string;
};

export type ProviderResourceAliases = {
  defaultRobotProfile?: string;
  latestReplayReport?: string;
  runtimeStatus?: string;
  runtimeBackends?: string;
  hostDependencyStatus?: string;
  cameraStatus?: string;
  cameraLenses?: string;
  latestCaptureMetadata?: string;
  speechStatus?: string;
  speechVoices?: string;
};

export type ProviderHostSurfaceContribution = {
  surface: ProviderHostSurfaceId;
  title?: string;
  description?: string;
  capabilityIds?: ProviderCapabilityId[];
  metadata?: ProviderUiSurfaceMetadata;
};

export type ProviderManifest = {
  familyId?: string;
  hostSurfaces?: ProviderHostSurfaceContribution[];
};

export type ProviderRuntimeContext = {
  backendId?: string;
  transportKind?: string;
  transportTarget?: string;
  executionSurface?: string;
};

export type ProviderArtifactReference = {
  kind: string;
  role?: string;
  uri?: string;
  title?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
};

export type ProviderExecutionContext = {
  providerId?: string;
  providerType?: string;
  sessionId?: string;
  runtime?: ProviderRuntimeContext;
  artifactRefs?: ProviderArtifactReference[];
};

export type ProviderEventEnvelope<TPayload = Record<string, unknown>> = {
  kind: string;
  providerId?: string;
  providerType?: string;
  timestampNs?: number;
  severity?: string;
  executionContext?: ProviderExecutionContext;
  artifactRefs?: ProviderArtifactReference[];
  payload?: TPayload;
};

export type ProviderRecommendation<TPayload = Record<string, unknown>> = {
  decision: string;
  reason?: string;
  confidence?: number;
  actionToolName?: string;
  summary?: string;
  executionContext?: ProviderExecutionContext;
  artifactRefs?: ProviderArtifactReference[];
  payload?: TPayload;
};

export type ProviderComparisonSummary<TMetrics = Record<string, unknown>> = {
  previousArtifactRef?: ProviderArtifactReference;
  previousGeneratedAtIso8601?: string;
  similarConditions?: boolean;
  summary?: string;
  metrics?: TMetrics;
  sharedEvidenceCategories?: string[];
  newEvidenceCategories?: string[];
  clearedEvidenceCategories?: string[];
};

export type ProviderEvaluationReport<TMetrics = Record<string, unknown>> = {
  kind: string;
  providerId?: string;
  providerType?: string;
  generatedAtIso8601?: string;
  sessionId?: string;
  summary?: string;
  executionContext?: ProviderExecutionContext;
  artifactRefs?: ProviderArtifactReference[];
  metrics?: TMetrics;
  recommendation?: ProviderRecommendation;
  comparison?: ProviderComparisonSummary;
};

export type ProviderAppliedUpdate<TPayload = Record<string, unknown>> = {
  kind: string;
  providerId?: string;
  providerType?: string;
  appliedAtIso8601?: string;
  status?: string;
  recommendationDecision?: string;
  summary?: string;
  executionContext?: ProviderExecutionContext;
  artifactRefs?: ProviderArtifactReference[];
  payload?: TPayload;
};

export type ProviderSummary = {
  id: string;
  title: string;
  description?: string;
  kind?: string;
  providerType?: string;
  configured?: boolean;
  rootUri?: string;
  transportProbeSupported?: boolean;
  capabilityIds?: ProviderCapabilityId[];
  discoverable?: boolean;
  error?: string;
  toolIds?: string[];
  resourceUris?: string[];
  toolAliases?: ProviderToolAliases;
  resourceAliases?: ProviderResourceAliases;
  manifest?: ProviderManifest;
};

export type ProviderDiscoveryEnvelope = {
  ok: boolean;
  providerId?: string;
  provider?: Record<string, unknown>;
  statusCode?: number;
  error?: string;
  stderr?: string;
};

export type ProviderResourceReadEnvelope<TValue = unknown> = {
  ok: boolean;
  providerId?: string;
  id?: string;
  uri: string;
  sourcePath?: string;
  exists?: boolean;
  value?: TValue | null;
  statusCode?: number;
  error?: string;
  stderr?: string;
};

export type ProviderToolCallEnvelope<TValue = unknown> = {
  ok: boolean;
  providerId?: string;
  name: string;
  value?: TValue;
  executionContext?: ProviderExecutionContext;
  statusCode?: number;
  error?: string;
  stderr?: string;
};

export type ProviderTransportProbeEnvelope<TValue = unknown> = {
  ok: boolean;
  providerId?: string;
  statusCode?: number;
  value?: TValue;
  executionContext?: ProviderExecutionContext;
  error?: string;
  stderr?: string;
};

export type ProviderProjectCapability =
  | "project_content_read"
  | "project_content_write";

export type ProviderInitializationContext = {
  projectId?: string | null;
  rootUri?: string | null;
  grantedCapabilities?: ProviderProjectCapability[];
  grantedPrefix?: string | null;
};

export type ProviderOperationOptions = {
  initialization?: ProviderInitializationContext | null;
};

export type ProviderRegistration = {
  id: string;
  summary: ProviderSummary;
  getSummary?: () => Promise<ProviderSummary> | ProviderSummary;
  discover: () => Promise<ProviderDiscoveryEnvelope> | ProviderDiscoveryEnvelope;
  readResource: <TValue = unknown>(
    uri: string,
    options?: ProviderOperationOptions,
  ) => Promise<ProviderResourceReadEnvelope<TValue>> | ProviderResourceReadEnvelope<TValue>;
  callTool: <TValue = unknown>(
    name: string,
    args?: Record<string, unknown>,
    options?: ProviderOperationOptions,
  ) => Promise<ProviderToolCallEnvelope<TValue>> | ProviderToolCallEnvelope<TValue>;
  transportProbe?: (
    body?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  handleLegacyRoute?: (context: unknown) => Promise<boolean> | boolean;
  getHealthDetails?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
};

export function createProviderRuntimeContext(
  input: Partial<ProviderRuntimeContext> | null | undefined,
): ProviderRuntimeContext;
export function createProviderHostSurfaceContribution(
  input: Partial<ProviderHostSurfaceContribution> | null | undefined,
): ProviderHostSurfaceContribution;
export function createProviderManifest(
  input: Partial<ProviderManifest> | null | undefined,
): ProviderManifest;
export function createProviderArtifactReference(
  input: Partial<ProviderArtifactReference> | null | undefined,
): ProviderArtifactReference;
export function createProviderExecutionContext(
  input: Partial<ProviderExecutionContext> | null | undefined,
): ProviderExecutionContext;
export function createProviderEventEnvelope<TPayload = Record<string, unknown>>(
  input: Partial<ProviderEventEnvelope<TPayload>> | null | undefined,
): ProviderEventEnvelope<TPayload>;
export function createProviderRecommendation<TPayload = Record<string, unknown>>(
  input: Partial<ProviderRecommendation<TPayload>> | null | undefined,
): ProviderRecommendation<TPayload>;
export function createProviderComparisonSummary<TMetrics = Record<string, unknown>>(
  input: Partial<ProviderComparisonSummary<TMetrics>> | null | undefined,
): ProviderComparisonSummary<TMetrics>;
export function createProviderEvaluationReport<TMetrics = Record<string, unknown>>(
  input: Partial<ProviderEvaluationReport<TMetrics>> | null | undefined,
): ProviderEvaluationReport<TMetrics>;
export function createProviderAppliedUpdate<TPayload = Record<string, unknown>>(
  input: Partial<ProviderAppliedUpdate<TPayload>> | null | undefined,
): ProviderAppliedUpdate<TPayload>;
export function createProviderSummary(input: Partial<ProviderSummary>): ProviderSummary;
export function isProviderDiscoverable(
  provider: Pick<ProviderSummary, "discoverable"> | null | undefined,
): boolean;
export function providerSupportsCapability(
  provider: Pick<ProviderSummary, "capabilityIds"> | null | undefined,
  capabilityId: ProviderCapabilityId | string,
): boolean;
export function findProviderForCapability(
  providers: Array<ProviderSummary | null | undefined>,
  capabilityId: ProviderCapabilityId | string,
  options?: { discoverableOnly?: boolean },
): ProviderSummary | null;
