import { useEffect, useState } from "react";
import { Text } from "../components/Text";
import {
  getLocalProviderHealthSnapshot,
  type LocalProviderHealthSnapshot,
  type LocalProviderSummary,
} from "../capabilities/localProviderHostClient";
import { supportsExtensionRemoteDeviceUi } from "./extensionFamilyUiRegistry";

function formatDeviceListSummary(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const devices = Array.isArray((value as { devices?: unknown[] }).devices)
    ? ((value as { devices: unknown[] }).devices as unknown[])
    : null;
  if (!devices || devices.length === 0) {
    return "No devices reported.";
  }

  const firstDevice =
    devices.find((device) => device && typeof device === "object" && !Array.isArray(device)) ??
    null;
  if (!firstDevice || typeof firstDevice !== "object" || Array.isArray(firstDevice)) {
    return `${devices.length} device${devices.length === 1 ? "" : "s"} available.`;
  }

  const label =
    typeof (firstDevice as { label?: unknown }).label === "string"
      ? (firstDevice as { label: string }).label
      : typeof (firstDevice as { deviceLabel?: unknown }).deviceLabel === "string"
        ? (firstDevice as { deviceLabel: string }).deviceLabel
        : "device";
  const state =
    typeof (firstDevice as { power_state?: unknown }).power_state === "string"
      ? (firstDevice as { power_state: string }).power_state
      : typeof (firstDevice as { powerState?: unknown }).powerState === "string"
        ? (firstDevice as { powerState: string }).powerState
        : null;

  return `${devices.length} device${devices.length === 1 ? "" : "s"} available · ${label}${state ? ` is ${state}` : ""}.`;
}

function formatHealthFreshnessLabel(checkedAt: string | null, nowMs: number) {
  if (!checkedAt) {
    return null;
  }
  const checkedMs = Date.parse(checkedAt);
  if (Number.isNaN(checkedMs)) {
    return null;
  }
  const diffMs = Math.max(0, nowMs - checkedMs);
  if (diffMs < 15_000) {
    return "Checked just now.";
  }
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) {
    return "Checked under a minute ago.";
  }
  if (diffMinutes === 1) {
    return "Checked 1 minute ago.";
  }
  if (diffMinutes < 60) {
    return `Checked ${diffMinutes} minutes ago.`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours === 1) {
    return "Checked 1 hour ago.";
  }
  return `Checked ${diffHours} hours ago.`;
}

function formatHostHealthSummaryFromValue(provider: LocalProviderSummary, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (provider.id === "simulated-devices" || provider.providerType === "simulated_devices") {
    const deviceSummary = formatDeviceListSummary(value);
    if (deviceSummary) {
      return {
        tone: "secondary" as const,
        text: deviceSummary,
      };
    }
  }

  if (supportsExtensionRemoteDeviceUi(provider.id)) {
    const record = value as Record<string, unknown>;
    const canCapture = record.canCapture === true;
    const permissionGranted = record.permissionGranted === true;
    const selectedLens =
      record.selectedLens === "rear" ||
      record.selectedLens === "front" ||
      record.selectedLens === "external"
        ? record.selectedLens
        : null;
    if (!canCapture) {
      return {
        tone: "warning" as const,
        text:
          typeof record.error === "string" && record.error.trim().length > 0
            ? record.error.trim()
            : permissionGranted
              ? "Camera is reachable, but cannot capture right now."
              : "Camera permission is not granted.",
      };
    }
    return {
      tone: "secondary" as const,
      text: `Camera ready${selectedLens ? ` · ${selectedLens} lens` : ""}.`,
    };
  }

  const record = value as Record<string, unknown>;
  const connection =
    typeof record.connection === "string" && record.connection.trim().length > 0
      ? record.connection.trim()
      : null;
  const batteryPct =
    typeof record.battery_pct === "number"
      ? record.battery_pct
      : typeof record.batteryPct === "number"
        ? record.batteryPct
        : null;
  const deviceId =
    typeof record.device_id === "string"
      ? record.device_id
      : typeof record.deviceId === "string"
        ? record.deviceId
        : null;
  const runtimeId =
    typeof record.runtime_id === "string"
      ? record.runtime_id
      : typeof record.runtimeId === "string"
        ? record.runtimeId
        : null;

  if (connection || batteryPct !== null || deviceId || runtimeId) {
    const parts = [];
    if (connection) {
      parts.push(`Host status: ${connection}`);
    } else {
      parts.push("Live status available");
    }
    if (batteryPct !== null) {
      parts.push(`battery ${batteryPct}%`);
    }
    if (deviceId) {
      parts.push(deviceId);
    }
    if (runtimeId) {
      parts.push(runtimeId);
    }
    return {
      tone: connection === "ready" ? ("secondary" as const) : ("muted" as const),
      text: `${parts.join(" · ")}.`,
    };
  }

  return null;
}

function formatHostHealthSummary(
  snapshot: LocalProviderHealthSnapshot,
  provider: LocalProviderSummary,
) {
  if (snapshot.source === "availability") {
    return {
      tone: snapshot.ok ? ("secondary" as const) : ("warning" as const),
      text: snapshot.ok ? "Local discovery available." : "Local discovery unavailable.",
    };
  }

  if (snapshot.source === "resource") {
    const resourceSummary = formatHostHealthSummaryFromValue(provider, snapshot.value);
    if (resourceSummary) {
      return resourceSummary;
    }
    return {
      tone: "secondary" as const,
      text: "Live status available.",
    };
  }

  if (snapshot.source === "transport_probe") {
    const value = snapshot.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        tone: "secondary" as const,
        text: "Transport probe connected.",
      };
    }

    const record = value as Record<string, unknown>;
    const connected =
      typeof record.connected === "boolean"
        ? record.connected
        : typeof record.ok === "boolean"
          ? record.ok
          : null;
    const transport = typeof record.transport === "string" ? record.transport : null;

    if (connected === false) {
      return {
        tone: "warning" as const,
        text: "Transport probe could not confirm a live connection.",
      };
    }

    return {
      tone: "secondary" as const,
      text: `Transport probe connected${transport ? ` · ${transport}` : ""}.`,
    };
  }

  if (!snapshot.ok) {
    return {
      tone: "warning" as const,
      text: "Unable to refresh live host status right now.",
    };
  }

  return {
    tone: "muted" as const,
    text: "Checking extension status…",
  };
}

function useFreshnessClock() {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  return nowMs;
}

export function HostExtensionHealthSummary({
  provider,
}: {
  provider: LocalProviderSummary;
}) {
  const [snapshot, setSnapshot] = useState<LocalProviderHealthSnapshot | null>(null);
  const nowMs = useFreshnessClock();

  useEffect(() => {
    let cancelled = false;

    async function loadSummary() {
      try {
        const nextSnapshot = await getLocalProviderHealthSnapshot(provider);
        if (!cancelled) {
          setSnapshot(nextSnapshot);
        }
      } catch {
        if (!cancelled) {
          setSnapshot({
            ok: false,
            source: "error",
            checkedAt: new Date().toISOString(),
            error: "Unable to refresh live host status right now.",
          });
        }
      }
    }

    void loadSummary();

    return () => {
      cancelled = true;
    };
  }, [provider]);

  const effectiveSnapshot =
    snapshot ?? {
      ok: provider.discoverable !== false,
      source: provider.discoverable === false ? ("availability" as const) : ("error" as const),
      checkedAt: null,
      error:
        provider.discoverable === false
          ? "Local discovery unavailable."
          : undefined,
    };
  const summary = formatHostHealthSummary(effectiveSnapshot, provider);
  const freshnessLabel = formatHealthFreshnessLabel(
    effectiveSnapshot.checkedAt ?? null,
    nowMs,
  );

  return (
    <div className="space-y-1">
      <Text
        variant="body"
        tone={summary.tone}
        data-testid={`project-provider-health-${provider.id}`}
        className="leading-5"
      >
        {summary.text}
      </Text>
      {freshnessLabel ? (
        <Text variant="caption" tone="subtle">
          {freshnessLabel}
        </Text>
      ) : null}
    </div>
  );
}
