import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import { isHostedRuntime, runtimeEntryIsReady } from "../utils/runtimeEntry";

export function sortRuntimeStatuses(
  entries: ControllerRuntimeStatusEntry[],
  preferCloudFirst: boolean,
): ControllerRuntimeStatusEntry[] {
  const healthOrder: Record<ControllerRuntimeStatusEntry["health"], number> = {
    online: 0,
    idle: 1,
    offline: 2,
  };
  return [...entries].sort((a, b) => {
    const diff = healthOrder[a.health] - healthOrder[b.health];
    if (diff !== 0) {
      return diff;
    }
    if (preferCloudFirst && a.isLocal !== b.isLocal) {
      return a.isLocal ? 1 : -1;
    }
    const labelA = a.displayName ?? a.runtimeId;
    const labelB = b.displayName ?? b.runtimeId;
    return labelA.localeCompare(labelB);
  });
}

export function resolvePreferredRuntimeEntry(
  runtimeStatuses: ControllerRuntimeStatusEntry[],
  preferredRuntimeId: string | null,
) {
  if (!preferredRuntimeId) {
    return null;
  }
  return runtimeStatuses.find((entry) => entry.runtimeId === preferredRuntimeId) ?? null;
}

export function resolveSessionRuntimeEntry(
  runtimeStatuses: ControllerRuntimeStatusEntry[],
  sessionRuntimeId: string | null,
) {
  if (!sessionRuntimeId) {
    return null;
  }
  return runtimeStatuses.find((entry) => entry.runtimeId === sessionRuntimeId) ?? null;
}

export function resolveReadyRuntimeEntries(runtimeStatuses: ControllerRuntimeStatusEntry[]) {
  return runtimeStatuses.filter((entry) => runtimeEntryIsReady(entry));
}

export function resolveRecommendedCloudRuntime(
  readyRuntimeEntries: ControllerRuntimeStatusEntry[],
) {
  const readyCloudRuntimes = readyRuntimeEntries.filter((entry) => !entry.isLocal);
  if (readyCloudRuntimes.length === 0) {
    return null;
  }
  return sortRuntimeStatuses(readyCloudRuntimes, true)[0] ?? null;
}

export function resolveWaitingForPreferredRuntime(args: {
  preferredRuntimeId: string | null;
  sessionRuntimeId: string | null;
  preferredRuntimeEntry: ControllerRuntimeStatusEntry | null;
}) {
  const { preferredRuntimeId, sessionRuntimeId, preferredRuntimeEntry } = args;
  if (!preferredRuntimeId || sessionRuntimeId) {
    return false;
  }
  if (!preferredRuntimeEntry) {
    return true;
  }
  return !runtimeEntryIsReady(preferredRuntimeEntry);
}

export function resolveEffectiveRuntimeSelection(args: {
  sessionRuntimeId: string | null;
  preferredRuntimeId: string | null;
}): {
  effectiveRuntimeId: string | null;
  effectiveRuntimeSource: "session" | "preference" | "auto";
} {
  const { sessionRuntimeId, preferredRuntimeId } = args;
  return {
    effectiveRuntimeId: sessionRuntimeId ?? preferredRuntimeId ?? null,
    effectiveRuntimeSource: sessionRuntimeId
      ? "session"
      : preferredRuntimeId
        ? "preference"
        : "auto",
  };
}

export function resolveRuntimeReady(args: {
  waitingForPreferredRuntime: boolean;
  effectiveRuntimeSource: "session" | "preference" | "auto";
  sessionRuntimeEntry: ControllerRuntimeStatusEntry | null;
  preferredRuntimeEntry: ControllerRuntimeStatusEntry | null;
  readyRuntimeEntries: ControllerRuntimeStatusEntry[];
}) {
  const {
    waitingForPreferredRuntime,
    effectiveRuntimeSource,
    sessionRuntimeEntry,
    preferredRuntimeEntry,
    readyRuntimeEntries,
  } = args;
  if (waitingForPreferredRuntime) {
    return false;
  }
  if (effectiveRuntimeSource === "session") {
    return runtimeEntryIsReady(sessionRuntimeEntry);
  }
  if (effectiveRuntimeSource === "preference") {
    return runtimeEntryIsReady(preferredRuntimeEntry);
  }
  return readyRuntimeEntries.length > 0;
}

export function resolveHasLocalRuntime(runtimeStatuses: ControllerRuntimeStatusEntry[]) {
  return runtimeStatuses.some((entry) => entry.isLocal);
}

export function resolveSelectedLocalRuntimeId(args: {
  sessionRuntimeEntry: ControllerRuntimeStatusEntry | null;
  preferredRuntimeEntry: ControllerRuntimeStatusEntry | null;
}) {
  const selectedRuntime = args.sessionRuntimeEntry ?? args.preferredRuntimeEntry;
  if (!selectedRuntime || !selectedRuntime.isLocal) {
    return null;
  }
  return selectedRuntime.runtimeId;
}

export function resolveShouldPromptCloudFallback(args: {
  preferredPromptDismissed: boolean;
  sessionRuntimeId: string | null;
  waitingForPreferredRuntime: boolean;
  runtimeReady: boolean;
  readyRuntimeCount: number;
  preferredRuntimeId: string | null;
  hasLocalRuntime: boolean;
}) {
  const {
    preferredPromptDismissed,
    sessionRuntimeId,
    waitingForPreferredRuntime,
    runtimeReady,
    readyRuntimeCount,
    preferredRuntimeId,
    hasLocalRuntime,
  } = args;
  if (preferredPromptDismissed) {
    return false;
  }
  if (sessionRuntimeId) {
    return false;
  }
  if (waitingForPreferredRuntime) {
    return true;
  }
  if (!runtimeReady && readyRuntimeCount === 0) {
    if (preferredRuntimeId) {
      return true;
    }
    if (hasLocalRuntime) {
      return true;
    }
    return false;
  }
  return false;
}

export function resolveLastReadyHostedRuntime(args: {
  activeProjectId: string | null;
  sessionRuntimeEntry: ControllerRuntimeStatusEntry | null;
  preferredRuntimeEntry: ControllerRuntimeStatusEntry | null;
  readyRuntimeEntries: ControllerRuntimeStatusEntry[];
}) {
  const {
    activeProjectId,
    sessionRuntimeEntry,
    preferredRuntimeEntry,
    readyRuntimeEntries,
  } = args;
  if (!activeProjectId) {
    return null;
  }
  const selectedReadyRuntime =
    [sessionRuntimeEntry, preferredRuntimeEntry].find(
      (entry) =>
        Boolean(entry) &&
        isHostedRuntime(entry as ControllerRuntimeStatusEntry) &&
        runtimeEntryIsReady(entry as ControllerRuntimeStatusEntry),
    ) ?? null;
  const readyHostedRuntime =
    selectedReadyRuntime ??
    readyRuntimeEntries.find((entry) => isHostedRuntime(entry)) ??
    null;
  if (!readyHostedRuntime?.runtimeId) {
    return null;
  }
  return {
    projectId: activeProjectId,
    runtimeId: readyHostedRuntime.runtimeId,
  };
}
