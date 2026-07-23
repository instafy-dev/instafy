import {
  normalizeBoolean,
  normalizeFiniteNumber,
  normalizeNonNegativeNumber,
  normalizeProviderAliases,
  normalizeRecord,
  normalizeStringArray,
  normalizeTrimmedString,
} from "./shared.js";
import { createProviderUiSurfaceMetadata } from "./provider-ui-surface.js";

function normalizeHostSurfaceContribution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const surface = normalizeTrimmedString(value.surface);
  if (!surface) {
    return null;
  }

  const metadata = createProviderUiSurfaceMetadata(value.metadata);

  return {
    surface,
    title: normalizeTrimmedString(value.title),
    description: normalizeTrimmedString(value.description),
    capabilityIds: normalizeStringArray(value.capabilityIds),
    metadata,
  };
}

export function createProviderHostSurfaceContribution(input) {
  return normalizeHostSurfaceContribution(input) ?? { surface: "" };
}

export function createProviderManifest(input) {
  const familyId = normalizeTrimmedString(input?.familyId);
  const hostSurfaces = Array.isArray(input?.hostSurfaces)
    ? input.hostSurfaces
        .map((surface) => normalizeHostSurfaceContribution(surface))
        .filter((surface) => Boolean(surface?.surface))
    : undefined;

  return {
    familyId,
    hostSurfaces: hostSurfaces?.length ? hostSurfaces : undefined,
  };
}

export function createProviderRuntimeContext(input) {
  return {
    backendId: normalizeTrimmedString(input?.backendId),
    transportKind: normalizeTrimmedString(input?.transportKind),
    transportTarget: normalizeTrimmedString(input?.transportTarget),
    executionSurface: normalizeTrimmedString(input?.executionSurface),
  };
}

export function createProviderArtifactReference(input) {
  const metadata = normalizeRecord(input?.metadata);

  return {
    kind: normalizeTrimmedString(input?.kind) ?? "",
    role: normalizeTrimmedString(input?.role),
    uri: normalizeTrimmedString(input?.uri),
    title: normalizeTrimmedString(input?.title),
    mimeType: normalizeTrimmedString(input?.mimeType),
    metadata,
  };
}

export function createProviderExecutionContext(input) {
  const runtime = input?.runtime ? createProviderRuntimeContext(input.runtime) : undefined;
  const artifactRefs = Array.isArray(input?.artifactRefs)
    ? input.artifactRefs
        .map((artifactRef) => createProviderArtifactReference(artifactRef))
        .filter((artifactRef) => artifactRef.kind)
    : undefined;

  return {
    providerId: normalizeTrimmedString(input?.providerId),
    providerType: normalizeTrimmedString(input?.providerType),
    sessionId: normalizeTrimmedString(input?.sessionId),
    runtime:
      runtime &&
      (runtime.backendId ||
        runtime.transportKind ||
        runtime.transportTarget ||
        runtime.executionSurface)
        ? runtime
        : undefined,
    artifactRefs: artifactRefs?.length ? artifactRefs : undefined,
  };
}

export function createProviderEventEnvelope(input) {
  const payload = normalizeRecord(input?.payload);
  const executionContext = input?.executionContext
    ? createProviderExecutionContext(input.executionContext)
    : undefined;
  const artifactRefs = Array.isArray(input?.artifactRefs)
    ? input.artifactRefs
        .map((artifactRef) => createProviderArtifactReference(artifactRef))
        .filter((artifactRef) => artifactRef.kind)
    : undefined;

  return {
    kind: normalizeTrimmedString(input?.kind) ?? "",
    providerId: normalizeTrimmedString(input?.providerId),
    providerType: normalizeTrimmedString(input?.providerType),
    timestampNs: normalizeNonNegativeNumber(input?.timestampNs),
    severity: normalizeTrimmedString(input?.severity),
    executionContext:
      executionContext &&
      (executionContext.providerId ||
        executionContext.providerType ||
        executionContext.sessionId ||
        executionContext.runtime ||
        executionContext.artifactRefs)
        ? executionContext
        : undefined,
    artifactRefs: artifactRefs?.length ? artifactRefs : undefined,
    payload,
  };
}

export function createProviderRecommendation(input) {
  const executionContext = input?.executionContext
    ? createProviderExecutionContext(input.executionContext)
    : undefined;
  const artifactRefs = Array.isArray(input?.artifactRefs)
    ? input.artifactRefs
        .map((artifactRef) => createProviderArtifactReference(artifactRef))
        .filter((artifactRef) => artifactRef.kind)
    : undefined;
  const payload = normalizeRecord(input?.payload);

  return {
    decision: normalizeTrimmedString(input?.decision) ?? "",
    reason: normalizeTrimmedString(input?.reason),
    confidence: normalizeFiniteNumber(input?.confidence),
    actionToolName: normalizeTrimmedString(input?.actionToolName),
    summary: normalizeTrimmedString(input?.summary),
    executionContext:
      executionContext &&
      (executionContext.providerId ||
        executionContext.providerType ||
        executionContext.sessionId ||
        executionContext.runtime ||
        executionContext.artifactRefs)
        ? executionContext
        : undefined,
    artifactRefs: artifactRefs?.length ? artifactRefs : undefined,
    payload,
  };
}

export function createProviderComparisonSummary(input) {
  const previousArtifactRef = input?.previousArtifactRef
    ? createProviderArtifactReference(input.previousArtifactRef)
    : undefined;
  const metrics = normalizeRecord(input?.metrics);

  return {
    previousArtifactRef:
      previousArtifactRef && previousArtifactRef.kind ? previousArtifactRef : undefined,
    previousGeneratedAtIso8601: normalizeTrimmedString(input?.previousGeneratedAtIso8601),
    similarConditions: normalizeBoolean(input?.similarConditions),
    summary: normalizeTrimmedString(input?.summary),
    metrics,
    sharedEvidenceCategories: normalizeStringArray(input?.sharedEvidenceCategories),
    newEvidenceCategories: normalizeStringArray(input?.newEvidenceCategories),
    clearedEvidenceCategories: normalizeStringArray(input?.clearedEvidenceCategories),
  };
}

export function createProviderEvaluationReport(input) {
  const executionContext = input?.executionContext
    ? createProviderExecutionContext(input.executionContext)
    : undefined;
  const artifactRefs = Array.isArray(input?.artifactRefs)
    ? input.artifactRefs
        .map((artifactRef) => createProviderArtifactReference(artifactRef))
        .filter((artifactRef) => artifactRef.kind)
    : undefined;
  const metrics = normalizeRecord(input?.metrics);
  const recommendation = input?.recommendation
    ? createProviderRecommendation(input.recommendation)
    : undefined;
  const comparison = input?.comparison
    ? createProviderComparisonSummary(input.comparison)
    : undefined;

  return {
    kind: normalizeTrimmedString(input?.kind) ?? "",
    providerId: normalizeTrimmedString(input?.providerId),
    providerType: normalizeTrimmedString(input?.providerType),
    generatedAtIso8601: normalizeTrimmedString(input?.generatedAtIso8601),
    sessionId: normalizeTrimmedString(input?.sessionId),
    summary: normalizeTrimmedString(input?.summary),
    executionContext:
      executionContext &&
      (executionContext.providerId ||
        executionContext.providerType ||
        executionContext.sessionId ||
        executionContext.runtime ||
        executionContext.artifactRefs)
        ? executionContext
        : undefined,
    artifactRefs: artifactRefs?.length ? artifactRefs : undefined,
    metrics,
    recommendation: recommendation?.decision ? recommendation : undefined,
    comparison:
      comparison &&
      (comparison.previousArtifactRef ||
        comparison.previousGeneratedAtIso8601 ||
        comparison.similarConditions !== undefined ||
        comparison.summary ||
        comparison.metrics ||
        comparison.sharedEvidenceCategories ||
        comparison.newEvidenceCategories ||
        comparison.clearedEvidenceCategories)
        ? comparison
        : undefined,
  };
}

export function createProviderAppliedUpdate(input) {
  const executionContext = input?.executionContext
    ? createProviderExecutionContext(input.executionContext)
    : undefined;
  const artifactRefs = Array.isArray(input?.artifactRefs)
    ? input.artifactRefs
        .map((artifactRef) => createProviderArtifactReference(artifactRef))
        .filter((artifactRef) => artifactRef.kind)
    : undefined;
  const payload = normalizeRecord(input?.payload);

  return {
    kind: normalizeTrimmedString(input?.kind) ?? "",
    providerId: normalizeTrimmedString(input?.providerId),
    providerType: normalizeTrimmedString(input?.providerType),
    appliedAtIso8601: normalizeTrimmedString(input?.appliedAtIso8601),
    status: normalizeTrimmedString(input?.status),
    recommendationDecision: normalizeTrimmedString(input?.recommendationDecision),
    summary: normalizeTrimmedString(input?.summary),
    executionContext:
      executionContext &&
      (executionContext.providerId ||
        executionContext.providerType ||
        executionContext.sessionId ||
        executionContext.runtime ||
        executionContext.artifactRefs)
        ? executionContext
        : undefined,
    artifactRefs: artifactRefs?.length ? artifactRefs : undefined,
    payload,
  };
}

export function createProviderSummary(input) {
  const id = normalizeTrimmedString(input?.id) ?? "";
  const title = normalizeTrimmedString(input?.title) ?? id;
  const manifest = input?.manifest ? createProviderManifest(input.manifest) : undefined;

  return {
    id,
    title,
    description: normalizeTrimmedString(input?.description),
    kind: normalizeTrimmedString(input?.kind),
    providerType: normalizeTrimmedString(input?.providerType),
    configured: normalizeBoolean(input?.configured),
    rootUri: normalizeTrimmedString(input?.rootUri),
    transportProbeSupported: normalizeBoolean(input?.transportProbeSupported),
    capabilityIds: normalizeStringArray(input?.capabilityIds),
    discoverable: normalizeBoolean(input?.discoverable),
    error: normalizeTrimmedString(input?.error),
    toolIds: normalizeStringArray(input?.toolIds),
    resourceUris: normalizeStringArray(input?.resourceUris),
    toolAliases: normalizeProviderAliases(input?.toolAliases, [
      "appendSessionEvents",
      "buildLearnDraft",
      "runReplayHarness",
      "importReplayReport",
      "bootstrapHostDependencies",
      "capturePhoto",
      "capturePhotoSeries",
      "transcribeAudio",
      "synthesizeSpeech",
    ]),
    resourceAliases: normalizeProviderAliases(input?.resourceAliases, [
      "defaultRobotProfile",
      "latestReplayReport",
      "runtimeStatus",
      "runtimeBackends",
      "hostDependencyStatus",
      "cameraStatus",
      "cameraLenses",
      "latestCaptureMetadata",
      "speechStatus",
      "speechVoices",
    ]),
    manifest:
      manifest &&
      (manifest.familyId ||
        (Array.isArray(manifest.hostSurfaces) && manifest.hostSurfaces.length > 0))
        ? manifest
        : undefined,
  };
}

export function isProviderDiscoverable(provider) {
  return provider?.discoverable !== false;
}

export function providerSupportsCapability(provider, capabilityId) {
  const normalizedCapabilityId = String(capabilityId || "").trim();
  if (!normalizedCapabilityId) {
    return true;
  }

  return (provider?.capabilityIds ?? []).includes(normalizedCapabilityId);
}

export function findProviderForCapability(providers, capabilityId, options = {}) {
  const discoverableOnly = options.discoverableOnly !== false;
  return (
    (providers ?? []).find((provider) => {
      if (!provider) {
        return false;
      }
      if (discoverableOnly && !isProviderDiscoverable(provider)) {
        return false;
      }
      return providerSupportsCapability(provider, capabilityId);
    }) ?? null
  );
}
