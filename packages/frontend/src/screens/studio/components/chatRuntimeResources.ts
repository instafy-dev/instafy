import { formatCpuLimitCores, formatUsagePair } from "../../../runtime/runtimeMenuShared";

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
