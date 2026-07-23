import { isUUID } from "../utils/uuid";

export interface PendingProjectSwitchSnapshot {
  projectId?: string | null;
  at?: number | null;
}

const PENDING_PROJECT_SWITCH_STORAGE_KEY = "instafy.pendingProjectSwitch";

function getRuntimeWindow() {
  if (typeof window === "undefined") {
    return null;
  }
  return window as typeof window & {
    __INSTAFY_PENDING_PROJECT_SWITCH__?: { projectId: string; at: number } | null;
  };
}

function normalizePendingProjectSwitch(
  value: PendingProjectSwitchSnapshot | null | undefined,
): { projectId: string; at: number } | null {
  const projectId =
    typeof value?.projectId === "string" && isUUID(value.projectId.trim())
      ? value.projectId.trim()
      : null;
  const at = typeof value?.at === "number" && Number.isFinite(value.at) ? value.at : null;
  if (!projectId || at === null) {
    return null;
  }
  return { projectId, at };
}

function readPendingProjectSwitchFromStorage(
  storage: Storage | null | undefined,
) {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(PENDING_PROJECT_SWITCH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PendingProjectSwitchSnapshot;
    return normalizePendingProjectSwitch(parsed);
  } catch {
    return null;
  }
}

function writePendingProjectSwitchToStorage(
  storage: Storage | null | undefined,
  snapshot: { projectId: string; at: number } | null,
) {
  if (!storage) {
    return;
  }
  try {
    if (snapshot) {
      storage.setItem(
        PENDING_PROJECT_SWITCH_STORAGE_KEY,
        JSON.stringify(snapshot),
      );
    } else {
      storage.removeItem(PENDING_PROJECT_SWITCH_STORAGE_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

export function readPendingProjectSwitch() {
  const runtimeWindow = getRuntimeWindow();
  const inMemory = normalizePendingProjectSwitch(
    runtimeWindow?.__INSTAFY_PENDING_PROJECT_SWITCH__ ?? null,
  );
  if (inMemory) {
    writePendingProjectSwitchToStorage(
      typeof window !== "undefined" ? window.sessionStorage : null,
      inMemory,
    );
    writePendingProjectSwitchToStorage(
      typeof window !== "undefined" ? window.localStorage : null,
      inMemory,
    );
    return inMemory;
  }

  const stored =
    readPendingProjectSwitchFromStorage(
      typeof window !== "undefined" ? window.sessionStorage : null,
    ) ??
    readPendingProjectSwitchFromStorage(
      typeof window !== "undefined" ? window.localStorage : null,
    );
  if (stored && runtimeWindow) {
    runtimeWindow.__INSTAFY_PENDING_PROJECT_SWITCH__ = stored;
  }
  return stored;
}

export function writePendingProjectSwitch(
  projectId: string,
  at = Date.now(),
) {
  const snapshot = normalizePendingProjectSwitch({ projectId, at });
  if (!snapshot) {
    return;
  }
  const runtimeWindow = getRuntimeWindow();
  if (runtimeWindow) {
    runtimeWindow.__INSTAFY_PENDING_PROJECT_SWITCH__ = snapshot;
  }
  writePendingProjectSwitchToStorage(
    typeof window !== "undefined" ? window.sessionStorage : null,
    snapshot,
  );
  writePendingProjectSwitchToStorage(
    typeof window !== "undefined" ? window.localStorage : null,
    snapshot,
  );
}

export function clearPendingProjectSwitch() {
  const runtimeWindow = getRuntimeWindow();
  if (runtimeWindow) {
    runtimeWindow.__INSTAFY_PENDING_PROJECT_SWITCH__ = null;
  }
  writePendingProjectSwitchToStorage(
    typeof window !== "undefined" ? window.sessionStorage : null,
    null,
  );
  writePendingProjectSwitchToStorage(
    typeof window !== "undefined" ? window.localStorage : null,
    null,
  );
}
