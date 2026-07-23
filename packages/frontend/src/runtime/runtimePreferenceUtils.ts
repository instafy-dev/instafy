export interface RuntimePreferenceDetails {
  runtimeId: string;
  source: string | null;
  displayName: string | null;
}

export function extractRuntimePreferenceDetails(
  details: Record<string, unknown> | null,
  metadata: Record<string, unknown> | null,
): RuntimePreferenceDetails | null {
  if (details && typeof details.runtimeId === "string") {
    return {
      runtimeId: details.runtimeId,
      source: typeof details.source === "string" ? details.source : null,
      displayName:
        typeof details.displayName === "string" &&
        details.displayName.trim().length > 0
          ? details.displayName.trim()
          : null,
    };
  }
  if (metadata) {
    const preference = metadata["runtimePreference"];
    if (isRecord(preference) && typeof preference.runtimeId === "string") {
      return {
        runtimeId: preference.runtimeId,
        source: typeof preference.source === "string" ? preference.source : null,
        displayName:
          typeof preference.displayName === "string" &&
          preference.displayName.trim().length > 0
            ? preference.displayName.trim()
            : null,
      };
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatFallbackRuntimeLabel(runtimeId: string): string {
  if (!runtimeId) {
    return "Runtime";
  }
  const trimmed = runtimeId.trim();
  if (trimmed.length <= 8) {
    return `Runtime ${trimmed}`;
  }
  return `Runtime ${trimmed.slice(0, 8)}`;
}

export function formatRuntimeSourceLabel(source: string | null): string | null {
  if (!source) {
    return null;
  }
  const normalized = source.trim().toLowerCase();
  switch (normalized) {
    case "project":
      return "Project preference";
    case "conversation":
      return null;
    case "user":
      return "Manual selection";
    default:
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
}
