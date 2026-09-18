const STORAGE_KEY = "instafy.projectSecrets.pendingCreate.v1";

export type PendingProjectSecretPrefill = {
  projectId?: string | null;
  name: string;
  description?: string | null;
  agentHandles?: string[];
  remainingNames?: string[];
  returnPanelTab?: "chat" | "secrets";
};

function normalizeHandle(handle: string): string | null {
  const trimmed = handle.trim();
  if (!trimmed) return null;
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const normalized = withoutAt.trim().toLowerCase();
  return normalized ? normalized : null;
}

function normalizePrefill(raw: unknown): PendingProjectSecretPrefill | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) {
    return null;
  }
  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : null;
  const description = typeof record.description === "string" ? record.description : null;
  const handles = Array.isArray(record.agentHandles)
    ? record.agentHandles
        .filter((value: unknown): value is string => typeof value === "string")
        .map((value) => normalizeHandle(value))
        .filter((value): value is string => Boolean(value))
    : [];
  const remainingNames = Array.isArray(record.remainingNames)
    ? record.remainingNames
        .filter((value: unknown): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];
  const returnPanelCandidate = typeof record.returnPanelTab === "string" ? record.returnPanelTab.trim().toLowerCase() : "";
  const returnPanelTab =
    returnPanelCandidate === "chat" || returnPanelCandidate === "secrets"
      ? returnPanelCandidate
      : undefined;

  return {
    projectId: projectId || null,
    name,
    description: description?.trim() ? description.trim() : null,
    agentHandles: handles.length > 0 ? handles : undefined,
    remainingNames: remainingNames.length > 0 ? remainingNames : undefined,
    returnPanelTab,
  };
}

/**
 * Carries which value the Secrets panel should open on, never the value itself.
 * PendingProjectSecretPrefill has no field for one, and normalizePrefill rebuilds
 * the object field by field from an allow list, so a `value` key present in the
 * stored JSON is dropped rather than round-tripped. The name of a secret is not
 * a secret: it is already on screen in the card that sent the person here.
 */
export function setPendingProjectSecretPrefill(prefill: PendingProjectSecretPrefill) {
  if (typeof window === "undefined") return;
  const normalized = normalizePrefill(prefill);
  if (!normalized) return;
  try {
    // codeql[js/clear-text-storage-of-sensitive-data] Only the variable name,
    // its description and the asking agent's handle are stored. See above.
    window.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage failures.
  }
}

export function readPendingProjectSecretPrefill(): PendingProjectSecretPrefill | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizePrefill(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function clearPendingProjectSecretPrefill() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}
