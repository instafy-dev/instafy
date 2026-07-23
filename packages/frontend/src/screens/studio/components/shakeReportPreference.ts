const SHAKE_REPORT_ENABLED_STORAGE_KEY = "instafy.shakeReportEnabled";

function hasStorage() {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

export function getStoredShakeReportEnabled() {
  if (!hasStorage()) {
    return false;
  }
  return window.localStorage.getItem(SHAKE_REPORT_ENABLED_STORAGE_KEY) === "1";
}

export function setStoredShakeReportEnabled(enabled: boolean) {
  if (!hasStorage()) {
    return;
  }
  window.localStorage.setItem(SHAKE_REPORT_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
}
