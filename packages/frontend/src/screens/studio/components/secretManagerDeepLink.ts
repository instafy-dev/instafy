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
 * Which value the Secrets panel should open its create form on, held in memory
 * for the one navigation that is about to happen.
 *
 * It lived in sessionStorage, which was more than the job needs and worse at
 * it. The panel switch that consumes this is a render away in the same
 * document, so nothing has to survive a reload, and a prefill that did survive
 * one would reopen a create form the person had already walked away from. Held
 * here it cannot outlive the page, reach another tab, or be read back by
 * anything but this module.
 *
 * It names a value; it never carries one. PendingProjectSecretPrefill has no
 * field for a value, and normalizePrefill rebuilds the object field by field
 * from an allow list, so a `value` an untyped caller supplies is dropped at the
 * boundary. The name itself is not a secret: it is already on screen in the
 * card that sent the person here.
 */
let pendingPrefill: PendingProjectSecretPrefill | null = null;

export function setPendingProjectSecretPrefill(prefill: PendingProjectSecretPrefill) {
  const normalized = normalizePrefill(prefill);
  // A prefill that does not name anything is not a reason to forget the one
  // already waiting, which is how the storage-backed version behaved too.
  if (!normalized) return;
  pendingPrefill = normalized;
}

export function readPendingProjectSecretPrefill(): PendingProjectSecretPrefill | null {
  // Rebuilt on the way out as well, so the caller holds its own copy and
  // cannot reach back into the one this module is keeping.
  return pendingPrefill ? normalizePrefill(pendingPrefill) : null;
}

export function clearPendingProjectSecretPrefill() {
  pendingPrefill = null;
}
