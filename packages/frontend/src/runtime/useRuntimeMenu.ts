import { useMemo } from "react";
import { useRuntime } from "./useRuntime";
import {
  getRuntimeLabel,
  runtimeAutoOptionLabel,
  type RuntimeStatusState,
  type RuntimeLabelInfo,
} from "./runtimeLabels";
import {
  isHostedRuntime,
  isSelfHostedRuntime,
} from "./utils/runtimeEntry";
import type {
  ControllerTunnelGrant,
  ControllerRuntimeStatusEntry,
  RuntimeResourceUsage,
} from "../sdk/instafy";

export type RuntimeMenuBadgeTone = "neutral" | "warning" | "danger";

export interface RuntimeMenuOption {
  id: string | null;
  label: string;
  detail: string | null;
  state: RuntimeStatusState;
  badge: { text: string; tone: RuntimeMenuBadgeTone } | null;
  isSessionOverride: boolean;
  tunnel: ControllerTunnelGrant | null;
  needsActivation: boolean;
  isLikelyLocal: boolean;
  resources?: RuntimeResourceUsage | null;
  isAuto?: boolean;
  endpoint?: string | null;
  launchedAt?: string | null;
  providerLabel?: string | null;
  provider?: string | null;
  isOwnedProvider?: boolean;
  runtimeImage?: string | null;
  runtimeHealth?: string | null;
  runtimeLastSeenAt?: string | null;
}

export interface RuntimeMenuAutoOption extends RuntimeMenuOption {}

export interface RuntimeMenuData {
  runtimeOptions: RuntimeMenuOption[];
  runtimeOptionsById: Map<string, RuntimeMenuOption>;
  autoOption: RuntimeMenuAutoOption;
  aggregateState: RuntimeStatusState;
  currentRuntime: RuntimeMenuOption;
  effectiveBadge: { text: string; tone: RuntimeMenuBadgeTone } | null;
}

function parseRuntimeTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function resolveRuntimeRecency(entry: ControllerRuntimeStatusEntry): number {
  return (
    parseRuntimeTimestamp(entry.lastSeenAt ?? null) ??
    parseRuntimeTimestamp(entry.createdAt ?? null) ??
    parseRuntimeTimestamp(entry.agentTokenIssuedAt ?? null) ??
    0
  );
}

function buildOfflineRuntimeKey(
  entry: ControllerRuntimeStatusEntry,
  info: RuntimeLabelInfo,
): string {
  const mode = entry.isLocal ? "local" : "hosted";
  const provider = (entry.provider ?? "").trim().toLowerCase();
  const label = info.label.trim().toLowerCase();
  return `${mode}:${provider}:${label}`;
}

export function useRuntimeMenuOptions(): RuntimeMenuData & {
  runtime: ReturnType<typeof useRuntime>;
} {
  const runtime = useRuntime();
  const {
    runtimeStatuses,
    localWorkspace,
    tunnelGrants,
    sessionRuntimeId,
    effectiveRuntimeId,
    effectiveRuntimeSource,
    preferredRuntimeId,
  } = runtime;
  const controllerProjectMissing = runtime.runtime.controllerProjectMissing;
  const controllerUnavailable = runtime.runtime.controllerUnavailable;

  const runtimeInfos = useMemo<
    Array<{ entry: ControllerRuntimeStatusEntry; info: RuntimeLabelInfo }>
  >(() => {
    const order: Record<RuntimeStatusState, number> = {
      online: 0,
      idle: 1,
      booting: 2,
      offline: 3,
    };
    const pinnedRuntimeIds = new Set(
      [sessionRuntimeId, effectiveRuntimeId, preferredRuntimeId].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      ),
    );
    const candidates = [...runtimeStatuses]
      .map((entry) => ({
        entry,
        info: getRuntimeLabel(
          entry,
          localWorkspace,
          tunnelGrants[entry.runtimeId] ?? null,
        ),
      }));
    const filtered: Array<{ entry: ControllerRuntimeStatusEntry; info: RuntimeLabelInfo }> = [];
    const seenOfflineByKey = new Set<string>();
    const seenBootingByKey = new Set<string>();
    const recencySorted = [...candidates].sort((a, b) => {
      return resolveRuntimeRecency(b.entry) - resolveRuntimeRecency(a.entry);
    });
    for (const candidate of recencySorted) {
      const runtimeId = candidate.entry.runtimeId;
      const pinned = Boolean(runtimeId && pinnedRuntimeIds.has(runtimeId));
      if (!pinned && candidate.info.statusState === "booting") {
        const key = buildOfflineRuntimeKey(candidate.entry, candidate.info);
        if (seenBootingByKey.has(key)) {
          continue;
        }
        seenBootingByKey.add(key);
      }
      if (!pinned && candidate.info.statusState === "offline") {
        const key = buildOfflineRuntimeKey(candidate.entry, candidate.info);
        if (seenOfflineByKey.has(key)) {
          continue;
        }
        seenOfflineByKey.add(key);
      }
      filtered.push(candidate);
    }
    return filtered
      .sort((a, b) => {
        const diff = order[a.info.statusState] - order[b.info.statusState];
        if (diff !== 0) {
          return diff;
        }
        if (a.entry.isLocal !== b.entry.isLocal) {
          return a.entry.isLocal ? 1 : -1;
        }
        const labelA = a.info.label ?? a.entry.runtimeId ?? "";
        const labelB = b.info.label ?? b.entry.runtimeId ?? "";
        const labelDiff = labelA.localeCompare(labelB);
        if (labelDiff !== 0) {
          return labelDiff;
        }
        return resolveRuntimeRecency(b.entry) - resolveRuntimeRecency(a.entry);
      });
  }, [
    runtimeStatuses,
    localWorkspace,
    tunnelGrants,
    sessionRuntimeId,
    effectiveRuntimeId,
    preferredRuntimeId,
  ]);

  const aggregateState = useMemo<RuntimeStatusState>(() => {
    if (runtimeInfos.some(({ info }) => info.statusState === "online")) {
      return "online";
    }
    if (runtimeInfos.some(({ info }) => info.statusState === "idle")) {
      return "idle";
    }
    if (runtimeInfos.some(({ info }) => info.statusState === "booting")) {
      return "booting";
    }
    return "offline";
  }, [runtimeInfos]);

  const runtimeOptions = useMemo<RuntimeMenuOption[]>(() => {
    return runtimeInfos.map(({ entry, info }) => {
      const runtimeTunnel =
        entry.runtimeId && tunnelGrants[entry.runtimeId]
          ? tunnelGrants[entry.runtimeId]
          : null;
      const originEndpoint =
        entry.origin?.endpoint?.trim() ??
        runtimeTunnel?.url ??
        runtimeTunnel?.hostname ??
        entry.endpointUrl ??
        null;
      const isLocalLike =
        info.isMyDevice || isSelfHostedRuntime(entry);
      const needsActivation =
        isLocalLike && (!originEndpoint || originEndpoint.length === 0);
      const detail = info.detail;
      const launchedAt =
        entry.createdAt ??
        entry.agentTokenIssuedAt ??
        entry.lastSeenAt ??
        null;

      return {
        id: entry.runtimeId,
        label: info.label,
        detail,
        state: info.statusState,
        badge: info.statusBadge
          ? { text: info.statusBadge.text, tone: info.statusBadge.tone ?? "neutral" }
          : null,
        isSessionOverride: sessionRuntimeId
          ? entry.runtimeId === sessionRuntimeId
          : false,
        tunnel: runtimeTunnel,
        needsActivation,
        isLikelyLocal: isLocalLike,
        isAuto: false,
        endpoint: originEndpoint,
        launchedAt,
        providerLabel: info.providerLabel,
        provider: entry.provider ?? null,
        isOwnedProvider: !isHostedRuntime(entry),
        resources: entry.resources ?? null,
        runtimeImage: entry.runtimeImage ?? null,
        runtimeHealth: entry.health ?? null,
        runtimeLastSeenAt: entry.lastSeenAt ?? null,
      };
    });
  }, [runtimeInfos, sessionRuntimeId, tunnelGrants]);

  const offlineBadge = useMemo(() => {
    if (
      localWorkspace?.status === "offline" ||
      localWorkspace?.status === "expired" ||
      localWorkspace?.presenceStatus === "offline"
    ) {
      return { text: "Offline", tone: "danger" } as const;
    }
    return null;
  }, [localWorkspace?.presenceStatus, localWorkspace?.status]);

  const degradedBadge = useMemo(() => {
    if (localWorkspace?.presenceStatus === "degraded") {
      return { text: "Degraded", tone: "warning" } as const;
    }
    return null;
  }, [localWorkspace?.presenceStatus]);

  const missingRuntimeOption: RuntimeMenuOption = useMemo(
    () => ({
      id: null,
      label: "Missing runtime",
      detail: "No runtime available",
      state: "offline" as RuntimeStatusState,
      badge: { text: "Missing", tone: "danger" },
      isSessionOverride: false,
      tunnel: null,
      needsActivation: false,
      isLikelyLocal: false,
      isAuto: false,
    }),
    [],
  );

  const unavailableProjectOption: RuntimeMenuOption = useMemo(
    () => ({
      id: null,
      label: "Space unavailable",
      detail: "This account cannot open the current space",
      state: "offline" as RuntimeStatusState,
      badge: { text: "No access", tone: "warning" },
      isSessionOverride: false,
      tunnel: null,
      needsActivation: false,
      isLikelyLocal: false,
      isAuto: false,
    }),
    [],
  );

  const unavailableControllerOption: RuntimeMenuOption = useMemo(
    () => ({
      id: null,
      label: "Instafy unavailable",
      detail: "The controller is temporarily unavailable",
      state: "offline" as RuntimeStatusState,
      badge: { text: "Retry", tone: "warning" },
      isSessionOverride: false,
      tunnel: null,
      needsActivation: false,
      isLikelyLocal: false,
      isAuto: false,
    }),
    [],
  );

  const autoOption: RuntimeMenuAutoOption = useMemo(
    () => ({
      id: null,
      label: runtimeAutoOptionLabel(),
      detail: "Let Instafy pick the healthiest runtime",
      state: aggregateState,
      badge: offlineBadge ?? degradedBadge,
      isSessionOverride: false,
      tunnel: null,
      needsActivation: false,
      isLikelyLocal: false,
      isAuto: true,
    }),
    [aggregateState, degradedBadge, offlineBadge],
  );

  const runtimeOptionsById = useMemo(() => {
    const map = new Map<string, RuntimeMenuOption>();
    for (const option of runtimeOptions) {
      if (option.id) {
        map.set(option.id, option);
      }
    }
    return map;
  }, [runtimeOptions]);

  const currentRuntime = useMemo<RuntimeMenuOption>(() => {
    if (controllerProjectMissing) {
      return unavailableProjectOption;
    }
    if (controllerUnavailable) {
      return unavailableControllerOption;
    }
    if (runtimeOptions.length === 0) {
      return missingRuntimeOption;
    }
    if (
      aggregateState === "offline" &&
      runtimeOptions.length > 0 &&
      !effectiveRuntimeId &&
      !sessionRuntimeId &&
      !preferredRuntimeId
    ) {
      return runtimeOptions[0] ?? missingRuntimeOption;
    }
    if (effectiveRuntimeId) {
      return (
        runtimeOptions.find((option) => option.id === effectiveRuntimeId) ??
        missingRuntimeOption
      );
    }
    if (effectiveRuntimeSource === "session" && sessionRuntimeId) {
      return (
        runtimeOptions.find((option) => option.id === sessionRuntimeId) ??
        missingRuntimeOption
      );
    }
    if (preferredRuntimeId) {
      return (
        runtimeOptions.find((option) => option.id === preferredRuntimeId) ??
        missingRuntimeOption
      );
    }
    return autoOption;
  }, [
    runtimeOptions,
    effectiveRuntimeId,
    effectiveRuntimeSource,
    sessionRuntimeId,
    preferredRuntimeId,
    aggregateState,
    controllerProjectMissing,
    controllerUnavailable,
    missingRuntimeOption,
    autoOption,
    unavailableControllerOption,
    unavailableProjectOption,
  ]);

  const effectiveBadge = useMemo(() => {
    if (controllerProjectMissing) {
      return unavailableProjectOption.badge;
    }
    if (controllerUnavailable) {
      return unavailableControllerOption.badge;
    }
    if (offlineBadge) {
      return offlineBadge;
    }
    if (degradedBadge) {
      return degradedBadge;
    }
    if (effectiveRuntimeSource === "session" && sessionRuntimeId) {
      return { text: "Session override", tone: "neutral" } as const;
    }
    return currentRuntime.badge;
  }, [
    currentRuntime.badge,
    controllerProjectMissing,
    controllerUnavailable,
    degradedBadge,
    offlineBadge,
    effectiveRuntimeSource,
    sessionRuntimeId,
    unavailableControllerOption.badge,
    unavailableProjectOption.badge,
  ]);

  return {
    runtime,
    runtimeOptions,
    runtimeOptionsById,
    autoOption,
    aggregateState,
    currentRuntime,
    effectiveBadge,
  };
}
