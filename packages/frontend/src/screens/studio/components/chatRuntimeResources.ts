function formatBytesCompact(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : value < 10 ? 1 : 0;
  const rounded = Math.round(value * 10 ** decimals) / 10 ** decimals;
  return `${rounded} ${units[unitIndex]}`;
}

function formatUsagePair(used: number | null | undefined, limit: number | null | undefined): string | null {
  if (typeof used !== "number" || Number.isNaN(used) || used < 0) {
    return null;
  }
  const usedLabel = formatBytesCompact(used);
  if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0) {
    return usedLabel;
  }
  return `${usedLabel} / ${formatBytesCompact(limit)}`;
}

function formatCpuLimitCores(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded)) {
    return `${rounded} cores`;
  }
  return `${rounded.toFixed(1)} cores`;
}

export function formatRuntimeResourcesSummary(resources: unknown): string | null {
  if (!resources || typeof resources !== "object") {
    return null;
  }

  const payload = resources as Record<string, unknown>;
  const segments: string[] = [];
  const cpuLimitCores = formatCpuLimitCores(typeof payload.cpuLimitCores === "number" ? payload.cpuLimitCores : null);
  if (typeof payload.cpuPct === "number" && Number.isFinite(payload.cpuPct)) {
    segments.push(
      cpuLimitCores
        ? `CPU ${Math.round(payload.cpuPct)}% (${cpuLimitCores})`
        : `CPU ${Math.round(payload.cpuPct)}%`,
    );
  } else if (cpuLimitCores) {
    segments.push(`CPU ${cpuLimitCores}`);
  }
  const memory = formatUsagePair(
    typeof payload.memoryUsedBytes === "number" ? payload.memoryUsedBytes : null,
    typeof payload.memoryLimitBytes === "number" ? payload.memoryLimitBytes : null,
  );
  if (memory) {
    segments.push(`RAM ${memory}`);
  }
  const disk = formatUsagePair(
    typeof payload.diskUsedBytes === "number" ? payload.diskUsedBytes : null,
    typeof payload.diskLimitBytes === "number" ? payload.diskLimitBytes : null,
  );
  if (disk) {
    segments.push(`Disk ${disk}`);
  }
  return segments.length > 0 ? segments.join(" · ") : null;
}
