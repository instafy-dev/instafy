export type ProviderEventConfig = {
  logMaxEntries: number;
  coalesceWindowMs: number;
  triggerMaxEntries: number;
};

const STORAGE_KEY = "instafy.providerEventConfig.v1";

export const DEFAULT_PROVIDER_EVENT_CONFIG: ProviderEventConfig = {
  logMaxEntries: 64,
  coalesceWindowMs: 2_000,
  triggerMaxEntries: 3,
};

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function normalizeProviderEventConfig(value: unknown): ProviderEventConfig {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    logMaxEntries: clampInteger(
      record.logMaxEntries,
      1,
      512,
      DEFAULT_PROVIDER_EVENT_CONFIG.logMaxEntries,
    ),
    coalesceWindowMs: clampInteger(
      record.coalesceWindowMs,
      0,
      60_000,
      DEFAULT_PROVIDER_EVENT_CONFIG.coalesceWindowMs,
    ),
    triggerMaxEntries: clampInteger(
      record.triggerMaxEntries,
      1,
      64,
      DEFAULT_PROVIDER_EVENT_CONFIG.triggerMaxEntries,
    ),
  };
}

let cachedProviderEventConfig = DEFAULT_PROVIDER_EVENT_CONFIG;
let loadedProviderEventConfig = false;

function loadProviderEventConfigFromStorage() {
  if (loadedProviderEventConfig || typeof window === "undefined") {
    return;
  }
  loadedProviderEventConfig = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }
    cachedProviderEventConfig = normalizeProviderEventConfig(JSON.parse(raw));
  } catch {
    cachedProviderEventConfig = DEFAULT_PROVIDER_EVENT_CONFIG;
  }
}

function persistProviderEventConfig() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedProviderEventConfig));
  } catch {
    // Ignore persistence failures.
  }
}

export function getProviderEventConfig(): ProviderEventConfig {
  loadProviderEventConfigFromStorage();
  return cachedProviderEventConfig;
}

export function setProviderEventConfig(nextConfig: Partial<ProviderEventConfig>) {
  cachedProviderEventConfig = normalizeProviderEventConfig({
    ...getProviderEventConfig(),
    ...nextConfig,
  });
  loadedProviderEventConfig = true;
  persistProviderEventConfig();
  return cachedProviderEventConfig;
}

export function resetProviderEventConfig() {
  cachedProviderEventConfig = DEFAULT_PROVIDER_EVENT_CONFIG;
  loadedProviderEventConfig = true;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore persistence failures.
    }
  }
  return cachedProviderEventConfig;
}
