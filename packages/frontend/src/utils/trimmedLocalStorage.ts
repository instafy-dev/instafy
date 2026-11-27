/** The trimmed value stored under `key`, or null when it is empty, missing or storage cannot be read. */
export function readStorageValue(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.localStorage.getItem(key)?.trim() ?? "";
    return value || null;
  } catch {
    return null;
  }
}

/** Stores the trimmed value under `key`, or removes the key when the value is empty or null. */
export function writeStorageValue(key: string, value: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (value && value.trim()) {
      window.localStorage.setItem(key, value.trim());
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore storage failures
  }
}
