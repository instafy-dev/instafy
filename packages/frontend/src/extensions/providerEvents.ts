import {
  createProviderArtifactReference,
  createProviderEventEnvelope,
  type ProviderArtifactReference,
  type ProviderEventEnvelope,
  type ProviderExecutionContext,
} from "@instafy/provider-contract";
import type { CameraCaptureMetadata } from "../camera/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeEventIdentity(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    const kind = typeof value.kind === "string" ? value.kind : "event";
    const providerId = typeof value.providerId === "string" ? value.providerId : "";
    const providerType = typeof value.providerType === "string" ? value.providerType : "";
    const timestampNs = typeof value.timestampNs === "number" ? String(value.timestampNs) : "";
    return [kind, providerId, providerType, timestampNs].join(":");
  }
}

export function serializeProviderEventIdentity(value: Record<string, unknown>): string {
  return serializeEventIdentity(value);
}

export function extractCapabilityEventRecords(values: unknown): Record<string, unknown>[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.filter(isRecord);
}

export function collectCapabilityEventRecords(...values: unknown[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const records: Record<string, unknown>[] = [];
  for (const value of values) {
    for (const event of extractCapabilityEventRecords(value)) {
      const identity = serializeEventIdentity(event);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      records.push(event);
    }
  }
  return records;
}

export function isProviderEventEnvelopeRecord(
  value: unknown,
): value is ProviderEventEnvelope<Record<string, unknown>> {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.kind !== "string" || value.kind.trim().length === 0) {
    return false;
  }
  return (
    typeof value.providerId === "string" ||
    typeof value.providerType === "string" ||
    isRecord(value.executionContext) ||
    Array.isArray(value.artifactRefs)
  );
}

export function extractProviderEventEnvelopes(
  values: unknown,
): ProviderEventEnvelope<Record<string, unknown>>[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.filter(isProviderEventEnvelopeRecord);
}

export function collectProviderEventEnvelopes(
  ...values: unknown[]
): ProviderEventEnvelope<Record<string, unknown>>[] {
  const seen = new Set<string>();
  const envelopes: ProviderEventEnvelope<Record<string, unknown>>[] = [];
  for (const value of values) {
    for (const event of extractProviderEventEnvelopes(value)) {
      const identity = serializeEventIdentity(event);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      envelopes.push(event);
    }
  }
  return envelopes;
}

function normalizeCaptureArtifact(capture: CameraCaptureMetadata): ProviderArtifactReference {
  return createProviderArtifactReference({
    kind: "image_capture",
    role: "observation",
    uri: capture.webPath?.trim() || capture.filePath?.trim() || undefined,
    title: capture.fileName?.trim() || capture.captureId,
    mimeType: capture.mimeType?.trim() || undefined,
    metadata: {
      captureId: capture.captureId,
      backend: capture.backend,
      lens: capture.lens,
      capturedAt: capture.capturedAt,
      width: capture.width ?? undefined,
      height: capture.height ?? undefined,
      sizeBytes: capture.sizeBytes ?? undefined,
      seriesIndex: capture.seriesIndex ?? undefined,
      format: capture.format ?? undefined,
    },
  });
}

export function createCameraObservationProviderEvent(input: {
  providerId: string;
  providerType?: string | null;
  executionContext?: ProviderExecutionContext | null;
  mode: "single" | "series";
  lens: string;
  requestedCount?: number | null;
  completedCount: number;
  capture?: CameraCaptureMetadata | null;
  captures?: CameraCaptureMetadata[] | null;
}): ProviderEventEnvelope<{
  mode: "single" | "series";
  lens: string;
  requestedCount?: number;
  completedCount: number;
  captureId?: string;
  captureIds?: string[];
}> {
  const captures = Array.isArray(input.captures)
    ? input.captures.filter(Boolean)
    : input.capture
      ? [input.capture]
      : [];
  const artifactRefs = captures.map((capture) => normalizeCaptureArtifact(capture));
  const primaryCapture = captures[0] ?? input.capture ?? null;

  return createProviderEventEnvelope({
    kind: input.mode === "series" ? "camera.photo_series_captured" : "camera.photo_captured",
    providerId: input.providerId,
    providerType: input.providerType?.trim() || input.executionContext?.providerType || "phone_camera",
    timestampNs: Date.now() * 1_000_000,
    executionContext: input.executionContext ?? undefined,
    artifactRefs,
    payload: {
      mode: input.mode,
      lens: input.lens,
      requestedCount:
        typeof input.requestedCount === "number" && Number.isFinite(input.requestedCount)
          ? input.requestedCount
          : undefined,
      completedCount: input.completedCount,
      captureId: primaryCapture?.captureId,
      captureIds: captures.length > 0 ? captures.map((capture) => capture.captureId) : undefined,
    },
  });
}
