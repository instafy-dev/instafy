const SUPPRESS_AUTO_CREATE_STORAGE_KEY = "instafy.suppressProjectAutoCreate";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

export function suppressProjectAutoCreate() {
  if (!canUseStorage()) {
    return;
  }
  try {
    window.localStorage.setItem(SUPPRESS_AUTO_CREATE_STORAGE_KEY, "1");
  } catch {
    // ignore storage failures
  }
}

export function clearProjectAutoCreateSuppression() {
  if (!canUseStorage()) {
    return;
  }
  try {
    window.localStorage.removeItem(SUPPRESS_AUTO_CREATE_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

export function isProjectAutoCreateSuppressed(): boolean {
  if (!canUseStorage()) {
    return false;
  }
  try {
    return window.localStorage.getItem(SUPPRESS_AUTO_CREATE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
