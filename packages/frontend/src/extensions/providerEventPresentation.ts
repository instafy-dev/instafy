import { collectProviderEventEnvelopes } from "./providerEvents";
import { resolveProviderEventHostReaction } from "./providerEventPolicy";

function titleCaseWords(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatArtifactCount(count: number) {
  return `${count} artifact${count === 1 ? "" : "s"}`;
}

function normalizeLensLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function humanizeEventKind(kind: string) {
  const normalized = kind
    .trim()
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return titleCaseWords(normalized);
}

function summarizeProviderEvent(
  event: Record<string, unknown>,
): { label: string; detail: string | null } | null {
  const kind = typeof event.kind === "string" ? event.kind.trim() : "";
  if (!kind) {
    return null;
  }
  const payload =
    typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;
  const artifactCount = Array.isArray(event.artifactRefs) ? event.artifactRefs.length : 0;

  if (kind === "camera.photo_captured") {
    const lens = normalizeLensLabel(payload?.lens);
    return {
      label: `${lens ? `${titleCaseWords(lens)} ` : ""}photo captured`,
      detail: artifactCount > 0 ? formatArtifactCount(artifactCount) : null,
    };
  }

  if (kind === "camera.photo_series_captured") {
    const lens = normalizeLensLabel(payload?.lens);
    const completedCount =
      typeof payload?.completedCount === "number" && Number.isFinite(payload.completedCount)
        ? Math.max(0, Math.floor(payload.completedCount))
        : 0;
    return {
      label: `${completedCount} ${lens ? `${lens} ` : ""}photo${completedCount === 1 ? "" : "s"} captured`.trim(),
      detail: artifactCount > 0 ? formatArtifactCount(artifactCount) : null,
    };
  }

  return {
    label: humanizeEventKind(kind),
    detail: artifactCount > 0 ? formatArtifactCount(artifactCount) : null,
  };
}

export function formatProviderEventSummaryLine(
  values: unknown,
  options?: { includeRecordOnly?: boolean },
): string | null {
  const events = collectProviderEventEnvelopes(values);
  if (events.length === 0) {
    return null;
  }

  const summaries = events
    .filter((event) => options?.includeRecordOnly || resolveProviderEventHostReaction(event) !== "record_only")
    .map((event) => summarizeProviderEvent(event as Record<string, unknown>))
    .filter((value): value is { label: string; detail: string | null } => value !== null)
    .map((summary) => (summary.detail ? `${summary.label} · ${summary.detail}` : summary.label));

  if (summaries.length === 0) {
    return null;
  }

  if (summaries.length === 1) {
    return summaries[0];
  }

  return `${summaries[0]} · +${summaries.length - 1} more`;
}
