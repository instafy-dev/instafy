export const RUNTIME_LIFECYCLE_MARKERS = [
  "registered runtime",
  "registration loop failed",
  "origin registration failed",
  "tunnel refresh requested",
  "lease request failed",
  "lease returned no jobs",
] as const;

export type RuntimeLifecycleMarker = (typeof RUNTIME_LIFECYCLE_MARKERS)[number];

export type RuntimeLifecycleMarkerSummary = {
  count: number;
  lastTimestamp: string | null;
};

export type RuntimeLifecycleSummary = {
  markers: Record<RuntimeLifecycleMarker, RuntimeLifecycleMarkerSummary>;
  httpStatusCounts: Record<string, number>;
};

const DOCKER_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?=\s)/;
const HTTP_STATUS_PATTERN =
  /(?:^|[\s,{])["']?(?:http[_-]?status(?:[_-]?code)?|httpStatus(?:Code)?|status[_-]?code|statusCode|status)["']?\s*[:=]\s*["']?([1-5]\d{2})["']?(?=$|[\s,}])/gi;

const MARKER_PATTERNS = Object.fromEntries(
  RUNTIME_LIFECYCLE_MARKERS.map((marker) => [
    marker,
    new RegExp(
      `(?:^|[^A-Za-z0-9_])${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^A-Za-z0-9_])`,
    ),
  ]),
) as Record<RuntimeLifecycleMarker, RegExp>;

function laterTimestamp(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current) return candidate;

  const currentMillis = Date.parse(current);
  const candidateMillis = Date.parse(candidate);
  if (Number.isFinite(currentMillis) && Number.isFinite(candidateMillis)) {
    if (candidateMillis !== currentMillis) {
      return candidateMillis > currentMillis ? candidate : current;
    }
  }

  // Docker emits UTC RFC3339 timestamps with fixed-width date/time fields. The
  // lexical fallback preserves sub-millisecond ordering when Date.parse has
  // truncated the fractional seconds.
  return candidate > current ? candidate : current;
}

function emptyMarkerSummaries(): Record<RuntimeLifecycleMarker, RuntimeLifecycleMarkerSummary> {
  return Object.fromEntries(
    RUNTIME_LIFECYCLE_MARKERS.map((marker) => [
      marker,
      {
        count: 0,
        lastTimestamp: null,
      },
    ]),
  ) as Record<RuntimeLifecycleMarker, RuntimeLifecycleMarkerSummary>;
}

/**
 * Reduces raw Docker output to an allowlisted lifecycle summary. Callers must
 * discard the source text and persist only this return value.
 */
export function summarizeRuntimeLifecycleLogs(logs: string): RuntimeLifecycleSummary {
  const markers = emptyMarkerSummaries();
  const httpStatusCounts: Record<string, number> = {};

  for (const line of logs.split(/\r?\n/)) {
    if (!line) continue;
    const timestamp = line.match(DOCKER_TIMESTAMP_PATTERN)?.[1] ?? null;
    let lifecycleLine = false;

    for (const marker of RUNTIME_LIFECYCLE_MARKERS) {
      if (!MARKER_PATTERNS[marker].test(line)) continue;
      lifecycleLine = true;
      markers[marker].count += 1;
      markers[marker].lastTimestamp = laterTimestamp(markers[marker].lastTimestamp, timestamp);
    }

    if (!lifecycleLine) continue;
    HTTP_STATUS_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(HTTP_STATUS_PATTERN)) {
      const status = match[1];
      httpStatusCounts[status] = (httpStatusCounts[status] ?? 0) + 1;
    }
  }

  const sortedHttpStatusCounts = Object.fromEntries(
    Object.entries(httpStatusCounts).sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    markers,
    httpStatusCounts: sortedHttpStatusCounts,
  };
}
