const STORAGE_KEY = "instafy.profile.agentProfileTarget.v1";

function normalizeHandle(handle: string): string | null {
  const trimmed = handle.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const lower = normalized.trim().toLowerCase();
  return lower ? lower : null;
}

export function setPendingAgentProfileTarget(handle: string) {
  if (typeof window === "undefined") return;
  const normalized = normalizeHandle(handle);
  if (!normalized) return;
  try {
    window.sessionStorage?.setItem(STORAGE_KEY, normalized);
  } catch {
    // Ignore storage failures (private browsing, disabled storage, etc.)
  }
}

export function readPendingAgentProfileTarget(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage?.getItem(STORAGE_KEY);
    return value ? normalizeHandle(value) : null;
  } catch {
    return null;
  }
}

export function clearPendingAgentProfileTarget() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

