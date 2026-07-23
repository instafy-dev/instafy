const GIT_AUTO_SYNC_STORAGE_KEY = "instafy.git.autoSyncAfterApply";

function parseStoredBoolean(value: string | null): boolean | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return null;
}

export function getGitAutoSyncAfterApplyPreference(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  const parsed = parseStoredBoolean(window.localStorage.getItem(GIT_AUTO_SYNC_STORAGE_KEY));
  return parsed ?? true;
}

export function setGitAutoSyncAfterApplyPreference(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(GIT_AUTO_SYNC_STORAGE_KEY, enabled ? "1" : "0");
}

